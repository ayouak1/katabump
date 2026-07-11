const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');

const PORT = 24706; // HidenCloud 分配的外部映射端口
const PASSWORD = 'ffd6c9cd-362a-429d-a02f-629837d40cfb'; // 密码，与之前的 UUID 保持一致

const BIN_PATH = '/home/container/node-gateway'; // 二进制伪装文件名
const CONFIG_PATH = '/home/container/config.yaml';
const CERT_PATH = '/home/container/server.crt';
const KEY_PATH = '/home/container/server.key';

// 官方发布稳定 v2.6.0，使用中转加速镜像以保证在境外Paas上的极速拉取
const DOWNLOAD_URL = 'https://mirror.ghproxy.com/https://github.com/apernet/hysteria/releases/download/app%2Fv2.6.0/hysteria-linux-amd64';

// 1. 创建 TCP 24706 端口上的前台合规伪装网页，阻断探针扫描与人工排查
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>System Status Gateway</title>
            <style>
                body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; text-align: center; padding: 50px; }
                h1 { color: #38bdf8; }
                .status { padding: 20px; background: #1e293b; border-radius: 8px; display: inline-block; margin-top: 20px; text-align: left; line-height: 1.8;}
            </style>
        </head>
        <body>
            <h1>System Status Gateway</h1>
            <p>High Performance Webhook & WebSocket Stream Hub</p>
            <div class="status">
                Gateway Status: Active (Healthy)<br>
                System Load Average: 0.08, 0.04, 0.01<br>
                Memory Allocated: 54.2 MB / 3072 MB<br>
                Node.js Version: ${process.version}
            </div>
        </body>
        </html>
    `);
});

// 2. 自动生成自签名开发证书
function ensureCertificates() {
    if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
        console.log('[证书生成] 未检测到 SSL 证书，正在通过 openssl 自动生成自签名开发证书...');
        try {
            execSync(`openssl req -x509 -nodes -newkey rsa:2048 -keyout ${KEY_PATH} -out ${CERT_PATH} -subj "/CN=zac.hidencloud.com" -days 3650`);
            console.log('[证书生成] 成功生成自签名 SSL 开发证书。');
        } catch (err) {
            console.error('[证书生成] 生成自签名证书失败 (可能环境缺少 openssl):', err.message);
            console.log('[证书生成] 写入静态内置自签名证书进行降级启动...');
            writeFallbackCertificates();
        }
    } else {
        console.log('[证书生成] 检测到已有自签名开发证书，跳过生成步骤。');
    }
}

// 降级证书数据（以防极少数容器环境彻底缺少 openssl）
function writeFallbackCertificates() {
    const fallbackCrt = `-----BEGIN CERTIFICATE-----
MIIDRDCCAigCCQDF34Kz52aOOTANBgkqhkiG9w0BAQsFADBFMQswCQYDVQQGEwJV
UzETMBEGA1UECAwKU29tZS1TdGF0ZTEhMB8GA1UECgwYSW50ZXJuZXQgV2lkZ2l0
cyBQdHkgTHRkMB4XDTI2MDcwOTEyMDAxM1oXDTM2MDcwNzEyMDAxM1owRTELMAkG
A1UEBhMCVVMxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoMGEludGVybmV0
IFdpZGdpdHMgUHR5IEx0ZDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AMXNn1v0y4Jz0EsNFA1gEnN/ZSiGKeTFNxoiHwQBAgEGgAOCAQ8AMIIBCgKCAQEA
tqp0M93Y4J0kM95W2B3T5s5A5X...
-----END CERTIFICATE-----`;

    const fallbackKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDFzZ9b9MuCc9BL
DRQNYBJ5/2UohinkxTccaIh8EQECCQaADggEDwAwggEKAoIBAQC2qnQz3djgnSQz
3lbYHdPmzkDldd...
-----END PRIVATE KEY-----`;

    fs.writeFileSync(CERT_PATH, fallbackCrt);
    fs.writeFileSync(KEY_PATH, fallbackKey);
}

// 3. 自动生成 config.yaml 配置文件
function ensureConfig() {
    const configContent = `listen: :${PORT}
tls:
  cert: ${CERT_PATH}
  key: ${KEY_PATH}
auth:
  type: password
  password: ${PASSWORD}
obfs:
  type: salamander
  salamander:
    password: ffd6c9cd-362a-429d-a02f-629837d40cfb
`;
    fs.writeFileSync(CONFIG_PATH, configContent);
    console.log('[网关部署] 成功生成 config.yaml 配置文件。');
}

// 4. 下载官方 Hysteria 2 二进制包
function downloadBinary() {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(BIN_PATH)) {
            console.log('[网关部署] node-gateway 文件已存在，跳过下载。');
            resolve();
            return;
        }

        console.log('[网关部署] 正在从加速镜像下载 node-gateway 二进制包...');
        const file = fs.createWriteStream(BIN_PATH);

        function getUrl(url) {
            const client = url.startsWith('https') ? https : http;
            client.get(url, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    getUrl(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`下载失败，HTTP 状态码: ${res.statusCode}`));
                    return;
                }
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log('[网关部署] node-gateway 下载成功。');
                    resolve();
                });
            }).on('error', (err) => {
                fs.unlink(BIN_PATH, () => {});
                reject(err);
            });
        }

        getUrl(DOWNLOAD_URL);
    });
}

// 5. 启动并守护可执行网关子进程
function startGateway() {
    console.log('[网关守护] 正在赋予可执行权限...');
    try {
        fs.chmodSync(BIN_PATH, '755');
    } catch (e) {
        console.warn('[网关守护] chmod 失败，尝试直接运行:', e.message);
    }

    console.log('[网关守护] 正在以 node-gateway 进程名启动 Hysteria 2 核心服务...');
    const gateway = spawn(BIN_PATH, ['server', '--config', CONFIG_PATH]);

    gateway.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output) console.log(`[Hysteria] ${output}`);
    });

    gateway.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) console.error(`[Hysteria ERROR] ${output}`);
    });

    gateway.on('close', (code) => {
        console.log(`[网关守护] 子进程关闭，退出码: ${code}。5秒后自动重新拉起...`);
        setTimeout(startGateway, 5000);
    });
}

// 主初始化流程
async function main() {
    try {
        ensureCertificates();
        ensureConfig();
        await downloadBinary();
        
        // 开启前台 TCP 24706 伪装网页监听
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`[伪装网页] TCP 监听已在 ${PORT} 端口成功启动`);
        });

        // 启动后台 UDP 24706 Hysteria 2 子进程
        startGateway();

    } catch (err) {
        console.error('[初始化失败] 遇到致命错误:', err.message);
    }
}

main();
