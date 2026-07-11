const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    // 1. 发送文字消息
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }

    // 2. 发送图片 (如果有)
    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        // 使用 curl 发送图片，避免引入额外的 multipart 依赖
        // 注意：Windows 本地测试可能需要环境支持 curl，GitHub Actions (Ubuntu) 默认支持
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] Failed to send photo via curl:', err.message);
                else console.log('[Telegram] Photo sent.');
                resolve();
            });
        });
    }
}

// 启用 stealth 插件
chromium.use(stealth);

// GitHub Actions 环境下的 Chrome 路径 (通常是 google-chrome)
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

// 确保 localhost 不走代理
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] TODO HTTP_PROXY 格式无效。期望格式: http://user:pass@host:port 或 http://host:port');
        process.exit(1);
    }
}

// --- INJECTED_SCRIPT ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    // 1. 模拟鼠标屏幕坐标
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    // 2. 简单的 attachShadow Hook
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
 
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

// 辅助函数：检测代理是否可用
async function checkProxy() {
    if (!PROXY_CONFIG) return true;

    console.log('[代理] 正在验证代理连接...');
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const axiosConfig = {
                proxy: {
                    protocol: 'http',
                    host: new URL(PROXY_CONFIG.server).hostname,
                    port: new URL(PROXY_CONFIG.server).port,
                },
                timeout: 10000
            };

            if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
                axiosConfig.proxy.auth = {
                    username: PROXY_CONFIG.username,
                    password: PROXY_CONFIG.password
                };
            }

            await axios.get('https://www.google.com', axiosConfig);
            console.log('[代理] 连接成功！');
            return true;
        } catch (error) {
            console.warn(`[代理] 连接尝试 ${attempt}/${maxRetries} 失败: ${error.message}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 3000));
            } else {
                console.error(`[代理] 经过 ${maxRetries} 次尝试，代理依然不可用。`);
                return false;
            }
        }
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    // 清除可能导致 Chrome 崩溃的无效 DBUS 地址
    delete process.env.DBUS_SESSION_BUS_ADDRESS;

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        // '--headless=new', // (已被注释) 使用 xvfb-run 时不需要 headless 模式，这样可以模拟有头浏览器增加成功率
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data' // 必须指定用户数据目录，否则远程调试可能失败
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    // 添加针对 Linux 环境的额外稳定性参数
    args.push('--disable-dev-shm-usage'); // 避免共享内存不足


    const fs = require('fs');
    const logStream = fs.createWriteStream('/tmp/chrome_startup.log');
    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    chrome.stdout.pipe(logStream);
    chrome.stderr.pipe(logStream);
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
        if (fs.existsSync('/tmp/chrome_startup.log')) {
            console.log('--- Chrome 启动错误日志 ---');
            console.log(fs.readFileSync('/tmp/chrome_startup.log', 'utf8'));
        }
        throw new Error('Chrome 启动失败');
    }
}

async function getExpiryDate(page) {
    try {
        const expiryLoc = page.getByText('Expiry:', { exact: false }).first();
        if (await expiryLoc.isVisible({ timeout: 5000 })) {
            const text = await expiryLoc.innerText();
            const match = text.match(/Expiry:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
            if (match) {
                return match[1].trim();
            }
        }
    } catch (e) {
        console.log('[获取到期日] 获取到期时间异常:', e.message);
    }
    return null;
}

function getUsers() {
    // 从环境变量读取 JSON 字符串
    // GitHub Actions Secret: USERS_JSON = [{"username":..., "password":...}]
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const url = frame.url();
            if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;

                const box = await iframeElement.boundingBox();
                if (!box) continue;

                console.log(`>> 发现 Turnstile Frame: ${url.substring(0, 80)}... 尺寸: ${box.width}x${box.height}，位置: (${box.x}, ${box.y})`);

                // 仅点击可见的、宽度符合正常验证框（宽度通常为 300px，高度约 65px）的 iframe
                if (box.width < 100 || box.height < 20) {
                    console.log('>> 该 Frame 尺寸不符合可见验证码框要求，跳过...');
                    continue;
                }

                // 标准 Turnstile 验证码框的复选框固定在左侧约 7% 宽度处，垂直居中
                const data = { xRatio: 0.07, yRatio: 0.5 };
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);

                console.log(`>> 视口点击目标坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                // 1. 模拟鼠标从随机位置滑入
                const startX = 100 + Math.random() * 200;
                const startY = 100 + Math.random() * 200;
                await page.mouse.move(startX, startY);
                await page.waitForTimeout(100 + Math.random() * 100);

                // 2. 平滑滑动到目标坐标 (通过 steps 模拟阻尼)
                const steps = 12 + Math.floor(Math.random() * 5);
                await page.mouse.move(clickX, clickY, { steps });
                await page.waitForTimeout(200 + Math.random() * 200);

                // 3. 物理按压与释放
                await page.mouse.down();
                await page.waitForTimeout(50 + Math.random() * 100);
                await page.mouse.up();

                console.log('>> Playwright 仿真平滑点击已发送。');
                return true;
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.warn('[代理] 代理最终无效！为了避免续约任务中断，将退回到直连模式运行...');
            PROXY_CONFIG = null; // 清除配置，Chrome 和 Playwright 将自动改走直连
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败。退出。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    // await page.addInitScript(INJECTED_SCRIPT);
    // console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`); // 隐去具体邮箱 logging

        const fs = require('fs');
        const path = require('path');
        const photoDir = path.join(process.cwd(), 'screenshots');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                // Context credentials apply
                // await page.addInitScript(INJECTED_SCRIPT);
            }

            // --- 登录逻辑 (简略版，逻辑一致) ---
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            // 总是先去登录页
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                // 如果登出没成功，再次登出
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // --- Cloudflare Turnstile Bypass for Login ---
                console.log('   >> 正在登录前检查 Turnstile (使用 CDP 绕过)...');
                let cdpClickResult = false;
                for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                    cdpClickResult = await attemptTurnstileCdp(page);
                    if (cdpClickResult) break;
                    await page.waitForTimeout(1000);
                }

                if (cdpClickResult) {
                    console.log('   >> 登录 CDP 点击生效。正在等待最多 10秒 Cloudflare 成功标志...');
                    for (let waitSec = 0; waitSec < 10; waitSec++) {
                        const frames = page.frames();
                        let isSuccess = false;
                        for (const f of frames) {
                            if (f.url().includes('cloudflare')) {
                                try {
                                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                        isSuccess = true;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }
                        if (isSuccess) {
                            console.log('   >> 登录前 Turnstile 验证成功。');
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }
                } else {
                    console.log('   >> 登录前未检测到或未点击 Turnstile，继续操作...');
                }
                // --------------------------------------------

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                // User Request: Check for incorrect password
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 用户 ${user.username} 账号或密码错误`);
                        const failShotPath = path.join(photoDir, `${safeUsername}.png`);
                        try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }

                        await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);

                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('登录错误:', e.message);
            }

            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('[异常] 未找到 "See" 按钮，可能无服务器或者控制台异常。');
                
                // 截图报错并爆红
                const errShotPath = path.join(photoDir, `${safeUsername}_error.png`);
                try { await page.screenshot({ path: errShotPath, fullPage: true }); } catch (err) { }
                await sendTelegramMessage(`🚨 *服务器运行异常报警*\n用户: ${user.username}\n原因: 未在面板首页找到您的服务器 (找不到 "See" 按钮)。请立刻检查服务器是否已被删除！`, errShotPath);
                process.exit(1);
            }

            // --- Renew 逻辑 ---
            const originalExpiry = await getExpiryDate(page);
            console.log(`[到期日] 续签前的到期时间: ${originalExpiry || '未获取到'}`);

            let renewSuccess = false;
            // 2. 一个扁平化的主循环：尝试 Renew 整个流程 (最多 20 次)
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                // 1. 如果是重试 (attempt > 1)，说明之前失败了或者刚刷新完页面
                // 我们直接开始寻找 Renew 按钮
                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    // 稍微等待一下，防止页面刚刷新还没渲染出来
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // A. 在模态框里晃晃鼠标
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    // B. 找 ALTCHA 或 Turnstile
                    console.log('正在检查验证 (ALTCHA 或 Turnstile)...');
                    const altchaWidget = modal.locator('altcha-widget');
                    if (await altchaWidget.isVisible()) {
                        console.log('>> 发现 ALTCHA 验证组件！尝试点击...');
                        const checkbox = altchaWidget.locator('input[type="checkbox"]');
                        await checkbox.click();
                        console.log('>> ALTCHA 复选框已点击。等待 5 秒进行 Proof of Work 算力哈希计算...');
                        await page.waitForTimeout(5000);
                    } else {
                        // fallback to Turnstile
                        let cdpClickResult = false;
                        for (let findAttempt = 0; findAttempt < 30; findAttempt++) {
                            cdpClickResult = await attemptTurnstileCdp(page);
                            if (cdpClickResult) break;
                            console.log(`   >> [寻找尝试 ${findAttempt + 1}/30] 尚未找到 Turnstile 复选框...`);
                            await page.waitForTimeout(1000);
                        }
                        if (cdpClickResult) {
                            console.log('   >> CDP 点击生效。等待 8秒 Cloudflare 检查...');
                            await page.waitForTimeout(8000);
                        } else {
                            console.log('   >> 重试后仍未确认 Turnstile 复选框。');
                        }
                    }

                    // C. 检查 Success 标志
                    const frames = page.frames();
                    let isTurnstileSuccess = false;
                    for (const f of frames) {
                        if (f.url().includes('cloudflare')) {
                            try {
                                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                    console.log('   >> 在 Turnstile iframe 中检测到 "Success!"。');
                                    isTurnstileSuccess = true;
                                    break;
                                }
                            } catch (e) { }
                        }
                    }

                    // D. 准备点击确认
                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {

                        // User Requested: Screenshot BEFORE final click
                        const tsScreenshotName = `${safeUsername}_Turnstile_${attempt}.png`;
                        try {
                            await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true });
                            console.log(`   >> 📸 快照已保存: ${tsScreenshotName}`);
                        } catch (e) { }

                        // User Request: 找不到的话这个循环直接下一步点击renew，然后检测有没有Please complete the captcha to continue
                        console.log('   >> 点击 Renew 确认按钮 (无论 Turnstile 状态如何)...');
                        await confirmBtn.click();

                        try {
                            // 1. Check for Errors (Captcha or Date limit)
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                // A. Captcha Error
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ 检测到错误: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }

                                // B. Not Renew Time Error
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    
                                    // 转换为中文日期
                                    const monthMap = {
                                        'January': '1月', 'February': '2月', 'March': '3月', 'April': '4月',
                                        'May': '5月', 'June': '6月', 'July': '7月', 'August': '8月',
                                        'September': '9月', 'October': '10月', 'November': '11月', 'December': '12月'
                                    };
                                    let displayDate = dateStr;
                                    const parts = dateStr.trim().split(/\s+/);
                                    if (parts.length === 2) {
                                        const day = parseInt(parts[0], 10);
                                        const monthChi = monthMap[parts[1]];
                                        if (monthChi) displayDate = `${monthChi}${day}日`;
                                    }
                                    
                                    console.log(`   >> ⏳ 暂无法续期。下次可用时间: ${displayDate}`);

                                    // 截图证明
                                    const skipShotPath = path.join(photoDir, `${safeUsername}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true }); } catch (e) { }

                                    await sendTelegramMessage(`⏳ *暂无法续期 (跳过)*\n用户: ${user.username}\n原因: 还没到时间\n下次可用: ${displayDate}`, skipShotPath);

                                    renewSuccess = true; // Mark as done to stop retries
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break; // Break loop if not time yet

                        if (hasCaptchaError) {
                            console.log('   >> Error found. Refreshing page to reset Turnstile...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue; // 刷新后，重新开始大循环
                        }

                        // F. 检查成功 (模态框消失，刷新页面做最终 Expiry 校验)
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> 模态框已关闭。正在强制刷新页面以验证到期时间是否发生变更...');
                            await page.reload();
                            await page.waitForTimeout(4000);

                            const newExpiry = await getExpiryDate(page);
                            console.log(`   >> 原始到期时间: ${originalExpiry || '未获取到'}, 当前最新到期时间: ${newExpiry || '未获取到'}`);

                            if (originalExpiry && newExpiry && newExpiry !== originalExpiry) {
                                console.log('   >> ✅ 到期时间发生变更！续约确认成功！');

                                // 截图成功状态
                                const successShotPath = path.join(photoDir, `${safeUsername}_success.png`);
                                try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) { }

                                await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n状态: 服务器已成功续期！\n新到期日: ${newExpiry}`, successShotPath);
                                renewSuccess = true;
                                break;
                            } else if (!originalExpiry && newExpiry) {
                                // 兜底：如果之前没获取到，但现在拿到了，也认为成了
                                console.log('   >> ✅ 成功捕获最新到期时间！续约确认成功！');
                                const successShotPath = path.join(photoDir, `${safeUsername}_success.png`);
                                try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) { }

                                await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n状态: 服务器已成功续期！\n新到期日: ${newExpiry}`, successShotPath);
                                renewSuccess = true;
                                break;
                            } else {
                                console.log('   >> ❌ 到期时间无变化或未获取到，判定实际上并未续期成功！正在刷新重试...');
                                await page.reload();
                                await page.waitForTimeout(3000);
                                continue;
                            }
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的验证按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('[异常] 未在页面找到 Renew 按钮，且没有触发“暂无法续期”的跳过警告！');
                    console.log('[异常] 这可能是因为服务器已被暂停、删除，或面板发生了结构性变化。');

                    // 截图报错
                    const errShotPath = path.join(photoDir, `${safeUsername}_error.png`);
                    try { await page.screenshot({ path: errShotPath, fullPage: true }); } catch (e) { }

                    await sendTelegramMessage(`🚨 *服务器运行异常报警*\n用户: ${user.username}\n原因: 找不到 Renew 按钮，可能服务器已被暂停、被删除，或面板发生了结构性变动。请立即登录控制台核对！`, errShotPath);

                    process.exit(1); // 强制爆红 Actions，引发警报
                }
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
        }

        // Snapshot before handling next user
        // In GitHub Actions, we save to 'screenshots' dir
        const screenshotPath = path.join(photoDir, `${safeUsername}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }

        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
