package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	tls_client "github.com/bogdanfinn/tls-client"
)

type Account struct {
	Username string `json: "username"`
	Password string `json: "password"`
}

func main() {
	fmt.Println("=== 启动 Go (tls-client) 指纹伪装登录测试 ===")

	// 1. 读取账户配置
	usersJSON := os.Getenv("USERS_JSON")
	if usersJSON == "" {
		fmt.Println("❌ 未检测到 USERS_JSON 环境变量")
		return
	}

	var accounts []Account
	err := json.Unmarshal([]byte(usersJSON), &accounts)
	if err != nil || len(accounts) == 0 {
		fmt.Printf("❌ 账户 JSON 解析错误: %v\n", err)
		return
	}
	account := accounts[0]
	fmt.Printf("准备测试账户: %s\n", account.Username)

	// 2. 初始化伪装成 Chrome 120 的 TLS 客户端
	options := []tls_client.HttpClientOption{
		tls_client.WithClientProfile(tls_client.Chrome_120), // 强行指定 Chrome 120 的 JA4/JA3 指纹
		tls_client.WithTimeout(30),
		tls_client.WithCookieJar(tls_client.NewCookieJar()),
	}

	client, err := tls_client.NewHttpClient(tls_client.NewLogger(), options...)
	if err != nil {
		fmt.Printf("❌ 初始化 TLS 客户端失败: %v\n", err)
		return
	}

	// 3. 第一次 GET 登录页，建立基本 cookie 关系
	fmt.Println("[1] GET 请求登录页面获取初始会话...")
	req, _ := tls_client.NewRequest("GET", "https://dashboard.katabump.com/auth/login", nil)
	req.Header.Set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
	req.Header.Set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("❌ GET 请求失败: %v\n", err)
		return
	}
	defer resp.Body.Close()
	fmt.Printf("    GET 响应状态码: %d\n", resp.StatusCode)

	// 4. 发送 POST 登录请求 (故意不带 cf-turnstile-response，依靠高信誉指纹免验证)
	fmt.Println("[2] POST 发送登录请求 (不带 Turnstile Token)...")
	data := url.Values{}
	data.Set("email", account.Username)
	data.Set("password", account.Password)
	data.Set("cf-turnstile-response", "") // 空 token

	postReq, _ := tls_client.NewRequest("POST", "https://dashboard.katabump.com/auth/login", strings.NewReader(data.Encode()))
	postReq.Header.Set("content-type", "application/x-www-form-urlencoded")
	postReq.Header.Set("origin", "https://dashboard.katabump.com")
	postReq.Header.Set("referer", "https://dashboard.katabump.com/auth/login")
	postReq.Header.Set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	postReq.Header.Set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")

	// 禁止自动重定向，以便我们捕获 Location 头
	client.SetFollowRedirect(false)

	postResp, err := client.Do(postReq)
	if err != nil {
		fmt.Printf("❌ POST 登录请求失败: %v\n", err)
		return
	}
	defer postResp.Body.Close()

	fmt.Printf("    POST 响应状态码: %d\n", postResp.StatusCode)
	location := postResp.Header.Get("Location")
	fmt.Printf("    重定向位置: %s\n", location)

	// 5. 诊断结果
	if postResp.StatusCode == 302 && strings.Contains(location, "dashboard") && !strings.Contains(location, "login") {
		fmt.Println("🎉【奇迹发生】Go 伪装指纹成功绕过验证码，直接登录进入 Dashboard！")
		
		// 尝试访问详情页
		client.SetFollowRedirect(true)
		getReq, _ := tls_client.NewRequest("GET", "https://dashboard.katabump.com/servers/edit?id=329980", nil)
		getReq.Header.Set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
		getResp, err := client.Do(getReq)
		if err == nil {
			defer getResp.Body.Close()
			bodyBytes, _ := io.ReadAll(getResp.Body)
			bodyStr := string(bodyBytes)
			if strings.Contains(bodyStr, "Expiry") {
				fmt.Println("✅ 成功拉取详情页内容！")
			}
		}
	} else {
		fmt.Println("❌ 失败：服务器依然拒绝了无验证码的登录请求（可能返回了 200/302 back to login）。")
		if postResp.StatusCode == 200 {
			bodyBytes, _ := io.ReadAll(postResp.Body)
			bodyStr := string(bodyBytes)
			if strings.Contains(bodyStr, "Please complete captcha") {
				fmt.Println("    具体原因: 页面仍然提示 'Please complete captcha'")
			} else {
				fmt.Printf("    页面前300字符: %s\n", bodyStr[:300])
			}
		}
	}
}
