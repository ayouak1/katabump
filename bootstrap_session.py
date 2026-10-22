"""
一次性取会话脚本：在本机（住宅 IP）登录 KataBump，导出登录态 Cookie，
再通过 `gh secret set SESSION_COOKIES` 上传到仓库，之后云端 Actions 即可跳过带 Turnstile 的登录页。
用法：python bootstrap_session.py
"""
import os, sys, json, time
from seleniumbase import SB
import renew_katabump as rk

def main():
    accounts = rk.load_accounts()
    if not accounts:
        print("未找到账号（login.json / USERS_JSON）"); sys.exit(1)
    acc = accounts[0]
    bot = rk.KataBumpRenew(acc['user'], acc['pass'])

    with SB(uc=True, incognito=True, window_size="1280,900") as sb:
        ok = False
        try:
            res = bot.login_flow(sb)
            ok = (res is True)
        except Exception as e:
            print(f"自动登录未通过: {e}")

        if not ok:
            print("\n>>> 请在弹出的浏览器里手动点验证码并登录，最多等待 180 秒 <<<\n")
            try:
                sb.uc_open_with_reconnect("https://dashboard.katabump.com/auth/login", 5)
            except Exception:
                pass
            for _ in range(90):
                time.sleep(2)
                try:
                    if "login" not in sb.get_current_url():
                        ok = True
                        break
                except Exception:
                    pass

        if not ok:
            print("登录未完成，退出"); sys.exit(2)

        sb.sleep(4)
        print("登录成功，当前 URL:", sb.get_current_url())
        cookies = sb.driver.get_cookies()
        # 同时补抓后台主域 cookie
        with open(rk.SESSION_FILE, 'w', encoding='utf-8') as f:
            json.dump(cookies, f, ensure_ascii=False)
        print(f"已导出 {len(cookies)} 个 Cookie -> {rk.SESSION_FILE}")
        for c in cookies:
            exp = c.get('expiry')
            exp_s = time.strftime('%Y-%m-%d %H:%M', time.localtime(exp)) if exp else 'session'
            print(f"  - {c['name']:<45} domain={c.get('domain')} exp={exp_s}")

if __name__ == "__main__":
    main()
