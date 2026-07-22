# Katabump Server Auto-Renewal Tool (SeleniumBase UC Mode)

[English Version](README_EN.md) | [中文说明](README.md)

这是一个基于 **Python + SeleniumBase UC Mode (Undetected ChromeDriver)** 的全自动 Katabump 服务器自动续期工具。无需手动导出 Cookie，直接原生绕过 Cloudflare Turnstile 人机验证码，支持在 GitHub Actions 云端及本地开箱即用。

---

## ✨ 核心特性

- **自动过盾 (Cloudflare Turnstile Solver)**：利用 SeleniumBase UC CDP 模式，原生自动过 Turnstile 验证码，无需付费打码平台。
- **无需导出/更新 Cookie**：直接基于账号密码在运行机器本地登录，自动生成并维护绑定当前 IP 的合法 Session，彻底摆脱 Cookie 频繁失效与 IP 封锁问题。
- **全流程自动化**：自动填入凭据 -> 过 Turnstile 验证 -> 自动计算 ALTCHA 算力（Proof of Work）-> 提交续期 -> 截图留存。
- **GitHub Actions 无缝集成**：内置后台 `xvfb` 支持，每天定时自动在 GitHub 跑续签任务。
- **Telegram 消息通知**：支持通知推送并随附结果截图。

---

## 🚀 GitHub Actions 云端部署指南 (推荐)

最省心的使用方式，一次配置，每天自动运行。

### 1. Fork 本仓库
点击右上角 **Fork** 将本项目保存到你自己的 GitHub 账号下。

### 2. 配置 Secrets 凭据
进入你的 GitHub 仓库：
**Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**

必须添加的 Secret：
- `USERS_JSON`
  - **格式**：标准的 JSON 数组（可包含多个账号）：
    ```json
    [
      { "username": "your_email@example.com", "password": "your_password" }
    ]
    ```

可选配置的 Secret：
- `TG_BOT_TOKEN`: Telegram Bot Token (从 @BotFather 获取)
- `TG_CHAT_ID`: Telegram Chat ID (接收推送消息的 Chat ID)

### 3. 运行与测试
- 提交配置后，点击仓库顶部的 **Actions** 标签页。
- 选择左侧 **Katabump Auto Renew** 工作流，点击右侧 **Run workflow** 手动触发测试。
- 工作流将在**每天北京时间 08:00 (UTC 00:00)** 自动定时运行。

---

## 💻 本地运行指南 (Windows / Linux)

### 1. 安装依赖

```bash
pip install -r requirements.txt
seleniumbase install chromedriver
```

### 2. 配置账号

在项目根目录新建或重命名 `login.json`：
```json
[
  {
    "username": "your_email@example.com",
    "password": "your_password"
  }
]
```

### 3. 运行续期脚本

```bash
python renew_katabump.py
```
*(如果需要强制测试全流程弹窗与点击，可设置环境变量 `FORCE_RENEW=true python renew_katabump.py`)*

---

## 📄 许可证

MIT License
