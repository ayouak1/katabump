#!/usr/bin/env python3
"""
KataBump 自动续期脚本 (基于 SeleniumBase UC Mode)

参考: peiqzh/Auto-Renew-Katabump + liveqte/Auto-Renew-Katabump + ayouak1/TWOKataBump-AutoRenew
核心: 使用 SeleniumBase UC Mode 自动过 Turnstile 验证
"""

import os, sys, time, logging, random, re, json
from datetime import datetime, timezone, timedelta

import requests
from seleniumbase import SB

# ===================== 配置 =====================
HEADLESS = os.getenv('HEADLESS', 'false').lower() == 'true'
ACCOUNTS_ENV = os.getenv('USERS_JSON', os.getenv('ACCOUNTS', ''))
TG_BOT_TOKEN = os.getenv('TG_BOT_TOKEN', os.getenv('BOT_TOKEN', ''))
TG_CHAT_ID = os.getenv('TG_CHAT_ID', os.getenv('CHAT_ID', ''))

# GHA 环境判定：如果在 GitHub Actions 中运行，忽略代理使用 Azure 优质高信誉原生 IP 绕过 CF 验证
IS_GHA = os.getenv('GITHUB_ACTIONS') == 'true'
PROXY_SERVER = os.getenv('HTTP_PROXY', os.getenv('HTTPS_PROXY', ''))
if IS_GHA:
    PROXY_SERVER = ''

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
        sb.open("https://dashboard.katabump.com/auth/login")
        sb.sleep(5)

        # 输入邮箱
        logger.info(f"📝 填写邮箱...")
        sb.type("input#email", self.user)
        sb.sleep(1.5)

        # 输入密码
        logger.info(f"🔒 填写密码...")
        sb.type("input#password", self.password)
        sb.sleep(1.5)

        # 尝试绕过 Turnstile
        logger.info(f"🛡️ 正在尝试过 Turnstile 验证码...")
        try:
            # SeleniumBase 强大的内置 CAPTCHA 物理点击绕过
            sb.uc_gui_click_captcha()
            logger.info("✅ Turnstile 物理点击完成")
        except Exception as e:
            logger.warning(f"⚠️ CAPTCHA 点击尝试遇到问题: {e}")

        # 轮询验证码 response token 是否生成 (双重确认)
        for _ in range(15):
            token = sb.execute_script(
                'return document.querySelector("input[name=\'cf-turnstile-response\']").value;')
            if token and len(token) > 20:
                logger.info("✅ Turnstile 验证已成功通过!")
                break
            sb.sleep(1)

        # 点击登录
        logger.info(f"📤 提交登录...")
        try:
            sb.click('button[type="submit"]')
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
                if days_diff > 1:
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
        
        # 使用 SeleniumBase SB 上下文管理器
        sb_args = {
            "uc": True,
            "headless": HEADLESS,
            "rt": 3,  # Reconnect attempts
        }
        if PROXY_SERVER:
            # SeleniumBase 支持直接传递代理参数，格式 --proxy=user:pass@host:port
            proxy_clean = PROXY_SERVER.replace("http://", "").replace("https://", "")
            sb_args["proxy"] = proxy_clean

        for attempt in range(max_retries):
            # 每次尝试创建独立的 SB 实例
            with SB(**sb_args) as sb:
                try:
                    if attempt > 0:
                        logger.info(f"🔄 第 {attempt+1} 次尝试重新运行流程...")
                    
                    success, msg = self.process(sb)
                    if success:
                        return True, msg
                    
                    last_error = msg
                    # 失败时保存本地截图
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
                    # 保存截图
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

    logger.info(f"📋 共加载 {len(accounts)} 个账户")
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
