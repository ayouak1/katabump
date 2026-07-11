#!/usr/bin/env python3
"""
KataBump 自动续期脚本 (基于 undetected-chromedriver)

参考: peiqzh/Auto-Renew-Katabump + liveqte/Auto-Renew-Katabump + ayouak1/TWOKataBump-AutoRenew
核心: uc 绕过 Turnstile + Altcha 弹窗验证
"""

import os, sys, time, logging, random, re, json
from datetime import datetime, timezone, timedelta

import requests
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.action_chains import ActionChains
from selenium.common.exceptions import TimeoutException, WebDriverException

# ===================== 配置 =====================
os.environ['NO_PROXY'] = 'localhost,127.0.0.1'
HEADLESS = os.getenv('HEADLESS', 'false').lower() == 'true'
ACCOUNTS_ENV = os.getenv('USERS_JSON', os.getenv('ACCOUNTS', ''))
PROXY_SERVER = os.getenv('HTTP_PROXY', os.getenv('HTTPS_PROXY', ''))
TG_BOT_TOKEN = os.getenv('TG_BOT_TOKEN', os.getenv('BOT_TOKEN', ''))
TG_CHAT_ID = os.getenv('TG_CHAT_ID', os.getenv('CHAT_ID', ''))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ===================== 工具 =====================
def rand_int(a, b): return random.randint(a, b)
def sleep_ms(ms): time.sleep(ms / 1000)
def human_delay(): sleep_ms(5000 + random.random() * 3000)

def get_chrome_major_version():
    """动态获取本地 Chrome 的主版本号以匹配 webdriver"""
    import subprocess
    v_env = os.getenv('CHROME_VERSION', '')
    if v_env.isdigit():
        return int(v_env)
        
    try:
        if sys.platform == "win32":
            chrome_dir = r"C:\Program Files\Google\Chrome\Application"
            if os.path.exists(chrome_dir):
                for item in os.listdir(chrome_dir):
                    if re.match(r'^\d+\.', item):
                        return int(item.split('.')[0])
        else:
            output = subprocess.check_output(["google-chrome", "--version"]).decode("utf-8")
            match = re.search(r"Google Chrome (\d+)\.", output)
            if match:
                return int(match.group(1))
    except Exception as e:
        logger.warning(f"无法自动检测 Chrome 大版本: {e}")
    return None

def human_type(driver, selector, text):
    try:
        el = WebDriverWait(driver, 15).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, selector)))
        el.clear()
        for ch in text:
            el.send_keys(ch)
            sleep_ms(rand_int(50, 150))
        return True
    except Exception as e:
        logger.warning(f"打字失败: {e}")
        return False

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

# ===================== 核心 =====================
class KataBumpRenew:
    def __init__(self, user, password):
        self.user = user
        self.password = password
        self.masked = mask_email(user)
        self.driver = None
        self.screenshot_path = None

    def setup_driver(self):
        opts = Options()
        if HEADLESS:
            opts.add_argument('--headless')
        opts.add_argument('--no-sandbox')
        opts.add_argument('--disable-dev-shm-usage')
        opts.add_argument('--disable-blink-features=AutomationControlled')
        opts.add_argument('--remote-debugging-port=9222')
        if PROXY_SERVER:
            opts.add_argument(f'--proxy-server={PROXY_SERVER}')

        v_main = get_chrome_major_version()
        logger.info(f"🛠 驱动初始化 - Chrome 大版本: {v_main or '自动'}")
        
        # 优先使用 Windows 常规路径以防 uc 找不到
        chrome_path = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
        
        try:
            if os.path.exists(chrome_path):
                self.driver = uc.Chrome(options=opts, headless=HEADLESS,
                                        browser_executable_path=chrome_path,
                                        version_main=v_main,
                                        use_subprocess=True)
            else:
                self.driver = uc.Chrome(options=opts, headless=HEADLESS,
                                        version_main=v_main,
                                        use_subprocess=True)
            self.driver.set_window_size(1280, 720)
            return
        except Exception as e:
            logger.error(f"Chrome 启动失败: {e}")
            if self.driver:
                try: self.driver.quit()
                except: pass
                self.driver = None
            raise

    def _handle_turnstile(self, context=""):
        """Cloudflare Turnstile — 偏移物理模拟点击"""
        try:
            container = WebDriverWait(self.driver, 15).until(
                EC.presence_of_element_located((By.CLASS_NAME, "cf-turnstile")))
            size = container.size
            # 计算偏置位置：宽度 * 0.12 是复选框的左偏移中心，垂直居中
            base_x = -(size['width'] / 2) + (size['width'] * 0.12)
            rand_x = base_x + random.uniform(-3, 3)
            rand_y = random.uniform(-3, 3)

            actions = ActionChains(self.driver)
            actions.move_to_element(container)
            actions.pause(random.uniform(0.5, 0.8))
            actions.move_to_element_with_offset(container, rand_x, rand_y)
            actions.click_and_hold()
            actions.pause(random.uniform(0.1, 0.2))
            actions.release()
            actions.perform()
            logger.info(f"🖱&nbsp;{self.masked} [{context}] Turnstile 偏移物理点击完成 (x_offset={rand_x:.1f})")

            # 轮询验证码 response token 是否生成
            for _ in range(15):
                token = self.driver.execute_script(
                    'return document.querySelector("input[name=\'cf-turnstile-response\']").value;')
                if token and len(token) > 20:
                    logger.info(f"✅ {self.masked} [{context}] Turnstile 验证码已通过!")
                    sleep_ms(1000 + random.random() * 1000)
                    return True
                sleep_ms(1000)
            logger.warning(f"⚠️ {self.masked} [{context}] Turnstile 验证超时")
            return False
        except Exception as e:
            logger.error(f"❌ {self.masked} [{context}] Turnstile 处理异常: {e}")
            return False

    def _handle_altcha(self):
        """续期弹窗的 Altcha 验证 — 勾选 required checkbox"""
        try:
            checkbox = WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable(
                    (By.XPATH, "//div[@class='altcha']//input[@type='checkbox' and @required]")))
            logger.info(f"✅ {self.masked} 发现并勾选 Altcha 验证框")
            checkbox.click()
            # Altcha 计算一般需要 5-8 秒
            sleep_ms(8000 + random.random() * 2000)
        except TimeoutException:
            logger.warning("⚠️ 未检测到 Altcha 复选框，跳过 Altcha 处理。")

    def process(self):
        """主续期流程"""
        logger.info(f"🚀 访问登录页: {self.masked}")
        self.driver.get("https://dashboard.katabump.com/auth/login")
        sleep_ms(5000 + random.random() * 2000)

        # 输入邮箱
        logger.info(f"📝 填写邮箱...")
        if not human_type(self.driver, "input#email", self.user):
            try:
                logger.error(f"🔍 [诊断] 当前 URL: {self.driver.current_url}")
                logger.error(f"🔍 [诊断] 页面 Title: {self.driver.title}")
                logger.error(f"🔍 [诊断] 页面 Source 前 1000 字符: {self.driver.page_source[:1000].strip()}")
            except Exception as diag_err:
                logger.error(f"🔍 [诊断] 无法获取诊断信息: {diag_err}")
            raise Exception("未找到邮箱输入框")
        sleep_ms(1000 + random.random() * 1000)

        # 输入密码
        logger.info(f"🔒 填写密码...")
        if not human_type(self.driver, "input#password", self.password):
            raise Exception("未找到密码输入框")
        sleep_ms(1000 + random.random() * 1000)

        # 尝试绕过 Turnstile
        self._handle_turnstile("Login")

        # 点击登录
        logger.info(f"📤 提交登录...")
        self.driver.find_element(By.CSS_SELECTOR, 'button[type="submit"]').click()
        human_delay()

        # 检测密码错误
        try:
            err_el = self.driver.find_elements(By.XPATH, "//*[contains(text(), 'Incorrect password')]")
            if err_el and err_el[0].is_displayed():
                logger.error(f"❌ {self.masked} 登录失败: 账号或密码错误")
                return False, f"❌ {self.masked} 账号或密码错误"
        except:
            pass

        # 检查是否登陆成功
        if "login" in self.driver.current_url:
            raise Exception("登录失败 — 页面未发生跳转，仍停留在登录页")

        # 进入服务器控制详情
        logger.info(f"🎯 正在进入服务器管理页...")
        manage_btn = WebDriverWait(self.driver, 30).until(
            EC.element_to_be_clickable((By.XPATH, "//a[contains(text(), 'See')]")))
        self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", manage_btn)
        sleep_ms(1000 + random.random() * 1000)
        self.driver.execute_script("arguments[0].click();", manage_btn)
        human_delay()

        # 检查到期时间
        logger.info(f"📅 正在检查到期日期...")
        try:
            expiry_el = WebDriverWait(self.driver, 15).until(
                EC.presence_of_element_located(
                    (By.XPATH, "//div[contains(text(), 'Expiry')]/following-sibling::div")))
            expiry_text = expiry_el.text.strip()
            logger.info(f"⌛ 当前到期时间: {expiry_text}")

            # 解析日期，Katabump 到期格式通常是 YYYY-MM-DD
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
        try:
            renew_btn = WebDriverWait(self.driver, 15).until(
                EC.element_to_be_clickable((By.XPATH, "//button[contains(text(), 'Renew')]")))
            self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", renew_btn)
            self.driver.execute_script("arguments[0].click();", renew_btn)
            logger.info(f"📑 成功打开续期模态弹窗")
        except Exception as e:
            raise Exception(f"无法打开 Renew 弹窗: {e}")

        sleep_ms(2000 + random.random() * 1000)

        # 勾选 Altcha 验证
        self._handle_altcha()

        # 提交续期
        try:
            confirm = WebDriverWait(self.driver, 10).until(
                EC.element_to_be_clickable(
                    (By.XPATH, "//div[@id='renew-modal']//button[@type='submit' and contains(text(), 'Renew')]")))
            self.driver.execute_script("arguments[0].click();", confirm)
            logger.info("📤 提交续期请求")
        except Exception as e:
            raise Exception(f"弹窗提交失败: {e}")

        sleep_ms(8000 + random.random() * 2000)

        # 结果核验
        try:
            alerts = self.driver.find_elements(By.CSS_SELECTOR, ".alert-danger")
            if alerts and alerts[0].is_displayed():
                msg = alerts[0].text.strip().replace('×', '')
                return False, f"⚠️ {self.masked} 续期失败: {msg}"

            final_el = self.driver.find_element(
                By.XPATH, "//div[contains(text(), 'Expiry')]/following-sibling::div")
            final = final_el.text.strip()
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
        for attempt in range(max_retries):
            try:
                if not self.driver:
                    self.setup_driver()
                if attempt > 0:
                    logger.info(f"🔄 第 {attempt+1} 次尝试重新运行流程...")
                    try: self.driver.quit()
                    except: pass
                    self.driver = None
                    self.setup_driver()
                    self.driver.get("https://dashboard.katabump.com/auth/login")
                    sleep_ms(5000 + random.random() * 3000)
                
                success, msg = self.process()
                if success:
                    return True, msg
                
                last_error = msg
                if "账号或密码错误" in msg or "续期失败:" in msg:
                    break
            except Exception as e:
                last_error = str(e)[:100]
                logger.error(f"❌ 运行异常 [第 {attempt+1} 次尝试]: {e}")
                if self.driver:
                    try: self.driver.quit()
                    except: pass
                    self.driver = None
                if attempt < max_retries - 1:
                    sleep_ms(5000 + random.random() * 5000)

        # 失败时保存本地截图
        self.screenshot_path = f"error-{self.user.split('@')[0]}.png"
        photo_dir = os.path.join(os.getcwd(), 'screenshots')
        if not os.path.exists(photo_dir):
            os.makedirs(photo_dir)
        full_screenshot_path = os.path.join(photo_dir, self.screenshot_path)
        if self.driver:
            try:
                self.driver.save_screenshot(full_screenshot_path)
                logger.info(f"📸 失败截图已保存到: {full_screenshot_path}")
            except:
                pass
        return False, f"❌ {self.masked} 最终运行失败: {last_error}"

# ===================== 加载账户列表 =====================
def load_accounts():
    accounts = []
    
    # 优先加载环境变量 USERS_JSON
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

        # 降级支持 user:pass,user:pass 串格式
        for a in re.split(r'[,;\n]', ACCOUNTS_ENV):
            a = a.strip()
            if ':' in a:
                u, p = a.split(':', 1)
                accounts.append({'user': u.strip(), 'pass': p.strip()})
        if accounts:
            return accounts

    # 降级读取本地的 login.json
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
    logger.info("🚀 KataBump Python 自动续签脚本启动")
    logger.info("=" * 60)

    accounts = load_accounts()
    if not accounts:
        logger.error("❌ 未配置账户信息 (USERS_JSON 环境变量为空，且本地 login.json 未找到)")
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

        if bot.driver:
            try:
                bot.driver.quit()
            except:
                pass
            bot.driver = None

        # 账号间隔，降低同 IP 频繁访问频率
        if i < len(accounts) - 1:
            wait = 10000 + random.random() * 5000
            logger.info(f"⏳ 等待 {wait/1000:.1f}s 后处理下一个账号...")
            time.sleep(wait / 1000)

    # 结果汇总与通知
    summary = f"📊 续签统计: {success_count}/{len(accounts)} 成功\n\n"
    summary += "\n\n".join([r['msg'] for r in results])
    logger.info("\n" + "="*60 + "\n" + summary + "\n" + "="*60)
    
    # 获取出错账号的最新截图进行发送
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
