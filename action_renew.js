const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ===================== 全局配置 =====================
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const COOKIES_JSON = process.env.KATABUMP_COOKIES || ''; // 新增：从环境变量读取 Session Cookies

// 发送 Telegram 消息
async function sendTelegramMessage(text, photoPath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    const url = photoPath 
        ? `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`
        : `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        
    const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' (北京时间)';
    const fullText = `🤖 *Katabump 续签任务报告*\n\n${text}\n\n执行时间: ${timeStr}`;
    
    try {
        if (photoPath && fs.existsSync(photoPath)) {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('chat_id', TG_CHAT_ID);
            form.append('caption', fullText);
            form.append('photo', fs.createReadStream(photoPath));
            await axios.post(url, form, { 
                headers: form.getHeaders(),
                timeout: 30000 
            });
        } else {
            await axios.post(url, {
                chat_id: TG_CHAT_ID,
                text: fullText,
                parse_mode: 'Markdown'
            }, { timeout: 15000 });
        }
        console.log('Telegram 消息发送成功。');
    } catch (e) {
        console.warn(`Telegram 发送失败: ${e.message}`);
    }
}

// 提取当前到期时间
async function getExpiryDate(page) {
    try {
        const text = await page.innerText('body');
        const match = text.match(/Expiry:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
        return match ? match[1] : null;
    } catch (e) {
        return null;
    }
}

// 自动回写 Cookie 到 GitHub Secrets
async function saveCookiesToSecret(context) {
    if (!process.env.GH_TOKEN) {
        console.log('[自维护] 未配置 GH_TOKEN 环境变量，跳过 Secret 自动回写。');
        return;
    }
    try {
        const cookies = await context.cookies();
        const cookiesStr = JSON.stringify(cookies);
        const tempPath = path.join(process.cwd(), 'temp_cookies.json');
        fs.writeFileSync(tempPath, cookiesStr, 'utf-8');
        
        console.log('[自维护] 发现有效登录会话，正在将最新 Cookie 自动更新至 GitHub Secrets (KATABUMP_COOKIES)...');
        const { execSync } = require('child_process');
        // 使用 shell 输入重定向方式，确保 JSON 传值完美防转义和注入
        execSync(`gh secret set KATABUMP_COOKIES < "${tempPath}"`, { stdio: 'inherit' });
        console.log('[自维护] ✅ GitHub Secrets 自动更新成功！');
        
        try { fs.unlinkSync(tempPath); } catch (e) {}
    } catch (err) {
        console.error('[自维护] ❌ 自动更新 Secrets 失败:', err.message);
    }
}

(async () => {
    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
    const successShotPath = path.join(photoDir, 'renew_success.png');
    const errShotPath = path.join(photoDir, 'renew_error.png');

    console.log('启动并初始化 Chrome (Session Cookie 绕过模式)...');
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--window-size=1280,720',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });

    // === 核心逻辑: 导入 Cookie 绕过登录 ===
    if (COOKIES_JSON) {
        console.log('检测到 KATABUMP_COOKIES 环境变量，正在注入会话 Cookie...');
        try {
            const rawCookies = JSON.parse(COOKIES_JSON);
            // 规范化 cookie 格式以适配 Playwright
            const formattedCookies = rawCookies.map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
                path: c.path || '/',
                secure: c.secure !== undefined ? c.secure : true,
                httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
                sameSite: c.sameSite || 'Lax'
            }));
            await context.addCookies(formattedCookies);
            console.log('Cookie 注入成功。');
        } catch (e) {
            console.error('⚠️ Cookie 注入解析失败，请检查格式是否为标准 JSON 数组:', e.message);
        }
    } else {
        console.warn('⚠️ 未检测到 KATABUMP_COOKIES，将尝试空白会话进行访问。');
    }

    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    try {
        // 直接访问服务器详情页 (跳过登录)
        const targetUrl = "https://dashboard.katabump.com/servers/edit?id=329980";
        console.log(`直接请求服务器详情页: ${targetUrl}`);
        await page.goto(targetUrl);
        await page.waitForTimeout(5000);

        // 验证是否已成功登录进入详情页
        const currentUrl = page.url();
        console.log(`当前 URL: ${currentUrl}`);

        if (currentUrl.includes('/auth/login')) {
            console.error('❌ Cookie 已经失效或无效，页面重定向回登录页！');
            await page.screenshot({ path: errShotPath, fullPage: true });
            await sendTelegramMessage('🚨 *续签异常报警*\n\n原因: 导入的 `KATABUMP_COOKIES` 会话已失效，被限制进入后台。请参考说明重新扫码更新 Cookie！', errShotPath);
            process.exit(1);
        }

        console.log('✅ 成功进入后台详情页！开始执行续期检查...');
        
        // 成功登录后，立即提取并回写最新的 Cookie
        await saveCookiesToSecret(context);

        const originalExpiry = await getExpiryDate(page);
        console.log(`续签前的到期时间: ${originalExpiry || '未获取到'}`);

        // 检查 Renew 按钮
        const renewBtn = page.locator("button:has-text('Renew'), a:has-text('Renew')").first;
        if (await renewBtn.isVisible({ timeout: 5000 })) {
            await renewBtn.click();
            console.log('已点击 Renew 按钮，等待模态框弹出...');
            await page.waitForTimeout(3000);

            // 检查模态框中的 ALTCHA 验证码
            const altcha = page.locator('altcha').first();
            if (await altcha.isVisible({ timeout: 3000 })) {
                console.log('发现 ALTCHA 验证组件，尝试点击解决...');
                await altcha.click();
                console.log('已点击 ALTCHA，等待 Proof of Work 计算完成...');
                await page.waitForTimeout(8000); // ALTCHA 算力通常需要 5-8 秒
            }

            // 确认 Renew
            const confirmBtn = page.locator("#renew-modal button:has-text('Renew')").first;
            if (await confirmBtn.isVisible({ timeout: 3000 })) {
                await confirmBtn.click();
                console.log('已确认 Renew，等待到期日更新...');
                await page.waitForTimeout(5000);
            }

            // 检查最新到期日
            const newExpiry = await getExpiryDate(page);
            console.log(`续签后的到期时间: ${newExpiry || '未获取到'}`);

            const pageText = await page.innerText('body');
            if (pageText.includes("You can't renew your server yet") || pageText.includes("not renew")) {
                console.log('⏰ 续约时间未到 (已跳过续约)。');
                await page.screenshot({ path: successShotPath, fullPage: true });
                await sendTelegramMessage(`⏰ *无需续签*\n\n状态: 续签时间未到，服务器正常运行中。\n当前到期日: ${originalExpiry || '获取失败'}`, successShotPath);
            } else if (newExpiry && newExpiry !== originalExpiry) {
                console.log('🎉 续签成功！');
                await page.screenshot({ path: successShotPath, fullPage: true });
                await sendTelegramMessage(`✅ *续签成功*\n\n新到期日: ${newExpiry}`, successShotPath);
            } else {
                console.log('❓ 状态未知，未检测到到期日变化。');
                await page.screenshot({ path: errShotPath, fullPage: true });
                await sendTelegramMessage('⚠️ *续签结果未知*\n\n点击了续签但到期日未更新，可能遇到验证码或其他拦截。', errShotPath);
            }
        } else {
            console.warn('⚠️ 未在页面中找到 Renew 按钮，可能格式有变。');
            await page.screenshot({ path: errShotPath, fullPage: true });
            await sendTelegramMessage('🚨 *续签异常*\n\n未在服务器编辑页中找到 Renew 按钮，请检查页面结构！', errShotPath);
        }

    } catch (e) {
        console.error(`脚本运行出错: ${e.stack}`);
        await page.screenshot({ path: errShotPath, fullPage: true });
        await sendTelegramMessage(`🚨 *脚本执行异常报错*\n\n错误信息: ${e.message}`, errShotPath);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
