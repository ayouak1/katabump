#!/usr/bin/env python3
"""
KataBump 自动续期脚本 (基于 SeleniumBase UC Mode)

参考: peiqzh/Auto-Renew-Katabump + liveqte/Auto-Renew-Katabump + ayouak1/TWOKataBump-AutoRenew
核心: 使用 SeleniumBase UC Mode 自动过 Turnstile 验证 (全自动代理模式 + 多级兜底过验证)
"""

import os, sys, time, logging, random, re, json
from datetime import datetime, timezone, timedelta

import requests
from seleniumbase import SB

# ===================== 配置 =====================
HEADLESS = os.getenv('HEADLESS', 'false').lower() == 'true'
FORCE_RENEW = os.getenv('FORCE_RENEW', 'false').lower() == 'true'
ACCOUNTS_ENV = os.getenv('USERS_JSON', os.getenv('ACCOUNTS', ''))
TG_BOT_TOKEN = os.getenv('TG_BOT_TOKEN', os.getenv('BOT_TOKEN', ''))
TG_CHAT_ID = os.getenv('TG_CHAT_ID', os.getenv('CHAT_ID', ''))

# 支持全局 HTTP/HTTPS 代理
PROXY_SERVER = os.getenv('HTTP_PROXY', os.getenv('HTTPS_PROXY', ''))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ===================== 工具 =====================
def sleep_ms(ms): time.sleep(ms / 1000)
def human_delay(): sleep_ms(5000 + random.random() * 3000)

def mask_email(email):
    try:
        if '@' in email:
            p, d = email.split('@', 1)
            return f"{p[0]}***@{d}" if len(p) > 2 else f"{p}***@{d}"
        return f"{email[0]}***"
    except:
        return "User"

# ===================== TG 通知 =====================
def send_tg(text, photo_path=None):
    if not TG_BOT_TOKEN or not TG_CHAT_ID:
        return
    tz = timezone(timedelta(hours=8))
    ts = datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S")
    full = f"🔄 KataBump 续期通知\n\n时间: {ts}\n\n{text}"
    try:
        if photo_path and os.path.exists(photo_path):
            requests.post(
                f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendPhoto",
                data={"chat_id": TG_CHAT_ID, "caption": full},
                files={'photo': open(photo_path, 'rb')}, timeout=20)
        else:
            requests.post(
                f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",
                data={"chat_id": TG_CHAT_ID, "text": full}, timeout=10)
    except Exception as e:
        logger.warning(f"TG 发送失败: {e}")


class KataBumpRenew:
    def __init__(self, user, password):
        self.user = user
        self.password = password
        self.masked = mask_email(user)
        self.screenshot_path = None

    def process(self, sb):
        """主续期流程"""
        logger.info(f"🚀 访问登录页: {self.masked}")
        sb.uc_open_with_reconnect("https://dashboard.katabump.com/auth/login", 6)
        sb.sleep(3)

        curr_title = sb.get_title()
        curr_url = sb.get_current_url()
        logger.info(f"📄 当前页面 Title: '{curr_title}', URL: '{curr_url}'")

        # 处理 Cloudflare "Just a moment..." 五秒盾/人机验证中间页
        if "Just a moment" in curr_title or "Cloudflare" in curr_title or "Attention Required" in curr_title:
            logger.info("🛡️ 检测到 Cloudflare 拦截中间页，等待自动或重连解封...")
            sb.uc_open_with_reconnect("https://dashboard.katabump.com/auth/login", 10)
            sb.sleep(5)
            logger.info(f"📄 解封后页面 Title: '{sb.get_title()}', URL: '{sb.get_current_url()}'")

        # 1. 优先等待并填写邮箱与密码
        logger.info(f"📝 填写邮箱...")
        try:
            sb.wait_for_element("input#email", timeout=20)
        except Exception as wait_err:
            logger.error(f"❌ 页面未出现 input#email！当前 Title: '{sb.get_title()}', URL: '{sb.get_current_url()}'")
            try:
                body_snippet = sb.get_text("body")[:300]
                logger.error(f"❌ 页面内容摘要: {body_snippet}")
            except:
                pass
            raise wait_err

        sb.type("input#email", self.user)
        sb.sleep(1)

        logger.info(f"🔒 填写密码...")
        sb.type("input#password", self.password)
        sb.sleep(1)

        # 2. 尝试辅助过 Turnstile 验证码
        logger.info(f"🛡️ 正在尝试过 Turnstile 验证码...")
        try:
            if sb.is_element_visible("div.cf-turnstile"):
                sb.uc_click("div.cf-turnstile")
                sb.sleep(3)
        except Exception as e:
            logger.warning(f"⚠️ uc_click div.cf-turnstile 尝试: {e}")

        # 3. 轮询等待验证码 token 生成（最多等待 20 秒）
        token_valid = False
        for _ in range(20):
            try:
                token = sb.execute_script('return (document.querySelector("input[name=\'cf-turnstile-response\']") || {}).value;')
                if token and len(token) > 20:
                    logger.info("✅ Turnstile 验证码已成功通过，获取到 Token！")
                    token_valid = True
                    break
            except:
                pass
            sb.sleep(1)

        # 4. 点击登录提交
        logger.info(f"📤 提交登录...")
        try:
            sb.uc_click('button[type="submit"]')
        except Exception as e:
            logger.warning(f"正常点击提交被拦截，尝试 JS 强制点击: {e}")
            sb.execute_script('document.querySelector("button[type=\'submit\']").click();')
        sb.sleep(6)

        # 检查是否登陆成功
        if "login" in sb.get_current_url():
            # 检查密码错误
            try:
                if sb.is_text_visible("Incorrect password", "body"):
                    return False, f"❌ {self.masked} 账号或密码错误"
            except:
                pass
            # 打印当前页面源码和 URL，方便排查
            logger.error(f"❌ 登录失败调试信息 - 当前 URL: {sb.get_current_url()}")
            try:
                page_text = sb.get_text("body").strip()
                logger.error(f"❌ 页面主体文字前500字符: {page_text[:500]}")
            except Exception as read_err:
                logger.error(f"❌ 读取页面文字失败: {read_err}")
            raise Exception("登录失败 — 仍在登录页，可能验证码未通过")

        # 进入服务器控制详情
        logger.info(f"🎯 正在进入服务器管理页...")
        sb.click("//a[contains(text(), 'See')]")
        sb.sleep(5)

        # 检查到期时间
        logger.info(f"📅 正在检查到期日期...")
        expiry_text = ""
        try:
            expiry_text = sb.get_text("//div[contains(text(), 'Expiry')]/following-sibling::div").strip()
            logger.info(f"⌛ 当前到期时间: {expiry_text}")

            # 解析日期
            today = datetime.now(timezone(timedelta(hours=8))).date()
            expiry_date = None
            for fmt in ["%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y"]:
                try:
                    expiry_date = datetime.strptime(expiry_text, fmt).date()
                    break
                except ValueError:
                    continue

            if expiry_date:
                days_diff = (expiry_date - today).days
                if days_diff > 1 and not FORCE_RENEW:
                    notice = f"⏰ {self.masked} - 暂无需续期 (到期日: {expiry_text}, 剩余 {days_diff} 天)"
                    logger.info(notice)
                    return True, notice
                elif days_diff < 0:
                    notice = f"⚠️ {self.masked} - 已过期 {abs(days_diff)} 天 (到期日: {expiry_text})，可能已被系统清理"
                    logger.warning(notice)
                    return False, notice
        except Exception as e:
            logger.warning(f"⚠️ 日期检查异常: {e}，将强制执行续期流程")

        # 点击 Renew 按钮展开弹窗
        logger.info(f"🔄 启动续期流程...")
        sb.click("//button[contains(text(), 'Renew')]")
        sb.sleep(3)

        # 勾选 Altcha 验证
        try:
            sb.click("//div[@class='altcha']//input[@type='checkbox' and @required]")
            logger.info("✅ 发现并勾选 Altcha 验证框，等待计算完成...")
            sb.sleep(8)
        except Exception:
            logger.info("⚠️ 未检测到 Altcha 复选框，跳过")

        # 提交续期
        logger.info("📤 提交续期请求...")
        try:
            sb.click("//div[@id='renew-modal']//button[@type='submit' and contains(text(), 'Renew')]")
        except Exception as e:
            logger.warning(f"常规点击续期按钮失败，尝试 JS 强制点击: {e}")
            sb.execute_script('document.evaluate("//div[@id=\'renew-modal\']//button[@type=\'submit\']", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue.click();')
        sb.sleep(8)

        # 结果核验
        try:
            if sb.is_element_visible(".alert-danger"):
                msg = sb.get_text(".alert-danger").strip().replace('×', '')
                return False, f"⚠️ {self.masked} 续期失败: {msg}"

            final = sb.get_text("//div[contains(text(), 'Expiry')]/following-sibling::div").strip()
            logger.info(f"✅ 续期后到期日期: {final}")
            if final and final != expiry_text:
                return True, f"✅ {self.masked}\n🎉 续期成功!\n📅 新到期日期: {final}"
            else:
                return False, f"⚠️ {self.masked} 续期后到期日未更新 ({final})"
        except Exception as e:
            return False, f"❌ {self.masked} 续签结果核验失败: {e}"

    def run(self):
        max_retries = 3
        last_error = ""
        
        sb_args = {
            "uc": True,
            "headless": HEADLESS,
        }
        
        if PROXY_SERVER:
            proxy_clean = PROXY_SERVER.replace("http://", "").replace("https://", "")
            sb_args["proxy"] = proxy_clean
            # 保证 127.0.0.1/localhost 不走代理，防止 Selenium 本地与 ChromeDriver 通信报 Service Unavailable
            os.environ['NO_PROXY'] = 'localhost,127.0.0.1,127.0.0.0/8,::1'

        for attempt in range(max_retries):
            with SB(**sb_args) as sb:
                try:
                    if attempt > 0:
                        logger.info(f"🔄 第 {attempt+1} 次尝试重新运行流程...")
                    
                    success, msg = self.process(sb)
                    if success:
                        return True, msg
                    
                    last_error = msg
                    self.screenshot_path = f"error-{self.user.split('@')[0]}.png"
                    photo_dir = os.path.join(os.getcwd(), 'screenshots')
                    if not os.path.exists(photo_dir):
                        os.makedirs(photo_dir)
                    sb.save_screenshot(os.path.join(photo_dir, self.screenshot_path))
                    
                    if "账号或密码错误" in msg or "续期失败:" in msg:
                        break
                except Exception as e:
                    last_error = str(e)[:100]
                    logger.error(f"❌ 运行异常 [第 {attempt+1} 次尝试]: {e}")
                    try:
                        self.screenshot_path = f"error-{self.user.split('@')[0]}.png"
                        photo_dir = os.path.join(os.getcwd(), 'screenshots')
                        if not os.path.exists(photo_dir):
                            os.makedirs(photo_dir)
                        sb.save_screenshot(os.path.join(photo_dir, self.screenshot_path))
                    except:
                        pass
                    
                    if attempt < max_retries - 1:
                        sleep_ms(5000 + random.random() * 5000)

        return False, f"❌ {self.masked} 最终运行失败: {last_error}"

# ===================== 加载账户列表 =====================
def load_accounts():
    accounts = []
    if ACCOUNTS_ENV:
        try:
            users = json.loads(ACCOUNTS_ENV)
            if isinstance(users, list):
                for u in users:
                    accounts.append({
                        'user': u.get('email', u.get('username', u.get('user', ''))),
                        'pass': u.get('password', u.get('pass', ''))
                    })
                return accounts
        except:
            pass

        for a in re.split(r'[,;\n]', ACCOUNTS_ENV):
            a = a.strip()
            if ':' in a:
                u, p = a.split(':', 1)
                accounts.append({'user': u.strip(), 'pass': p.strip()})
        if accounts:
            return accounts

    login_path = os.path.join(os.path.dirname(__file__), 'login.json')
    if os.path.exists(login_path):
        try:
            with open(login_path, 'r', encoding='utf-8') as f:
                users = json.load(f)
                if isinstance(users, list):
                    for u in users:
                        accounts.append({
                            'user': u.get('email', u.get('username', u.get('user', ''))),
                            'pass': u.get('password', u.get('pass', ''))
                        })
                else:
                    accounts.append({
                        'user': users.get('email', users.get('username', users.get('user', ''))),
                        'pass': users.get('password', users.get('pass', ''))
                    })
            return accounts
        except Exception as e:
            logger.error(f"读取本地 login.json 失败: {e}")

    return accounts

# ===================== 主函数 =====================
def main():
    logger.info("=" * 60)
    logger.info("🚀 KataBump Auto Renew (SeleniumBase) 启动")
    logger.info("=" * 60)

    accounts = load_accounts()
    if not accounts:
        logger.error("❌ 未配置账户")
        send_tg("❌ KataBump 续期失败\n原因: 未配置任何账户")
        sys.exit(1)

    logger.info(f"📋 共加载 {len(accounts)} 个账号")
    results = []
    success_count = 0

    for i, acc in enumerate(accounts):
        logger.info(f"\n{'-'*30}\n📋 正在处理第 {i+1}/{len(accounts)} 个账号")
        bot = KataBumpRenew(acc['user'], acc['pass'])
        success, msg = bot.run()
        results.append({'msg': msg, 'ok': success})
        if success:
            success_count += 1

        if i < len(accounts) - 1:
            wait = 10000 + random.random() * 5000
            logger.info(f"⏳ 等待 {wait/1000:.1f}s 后处理下一个账号...")
            time.sleep(wait / 1000)

    summary = f"📊 续签统计: {success_count}/{len(accounts)} 成功\n\n"
    summary += "\n\n".join([r['msg'] for r in results])
    logger.info("\n" + "="*60 + "\n" + summary + "\n" + "="*60)
    
    err_shot = None
    for i, r in enumerate(results):
        if not r['ok']:
            user_part = accounts[i]['user'].split('@')[0]
            err_path = os.path.join(os.getcwd(), 'screenshots', f"error-{user_part}.png")
            if os.path.exists(err_path):
                err_shot = err_path
                break

    send_tg(summary, err_shot)
    sys.exit(0 if success_count == len(accounts) else 1)

if __name__ == "__main__":
    main()
