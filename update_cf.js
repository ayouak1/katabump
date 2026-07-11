require('dotenv').config();
const axios = require('axios');

const CF_EMAIL = process.env.CF_EMAIL || '';
const CF_KEY = process.env.CF_KEY || '';
const ZONE_ID = process.env.ZONE_ID || '';

const TARGET_DOMAIN = 'kb.ayouaka.eu.cc';
const NEW_IP = '51.68.234.157';
const NEW_PORT = 20355;

const headers = {
    'X-Auth-Email': CF_EMAIL,
    'X-Auth-Key': CF_KEY,
    'Content-Type': 'application/json'
};

async function main() {
    try {
        console.log(`=== [开始] 正在通过 Cloudflare API 对接新容器 ===`);
        
        // 1. 获取并更新 DNS 记录
        console.log(`[DNS] 正在查找域名 ${TARGET_DOMAIN} 的 DNS 记录...`);
        const dnsListUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${TARGET_DOMAIN}`;
        const dnsRes = await axios.get(dnsListUrl, { headers });
        const dnsRecords = dnsRes.data.result;
        
        if (!dnsRecords || dnsRecords.length === 0) {
            throw new Error(`未在 CF 中找到域名 ${TARGET_DOMAIN} 的 DNS 记录！`);
        }
        
        const record = dnsRecords[0];
        console.log(`[DNS] 找到现有 DNS 记录: ID=${record.id}, 当前 IP=${record.content}, 橙云代理=${record.proxied}`);
        
        console.log(`[DNS] 正在将 IP 修改为 ${NEW_IP}...`);
        const dnsPatchUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${record.id}`;
        await axios.patch(dnsPatchUrl, {
            content: NEW_IP,
            proxied: true
        }, { headers });
        console.log(`[DNS] ✅ DNS 记录更新成功！`);

        // 2. 获取并更新 Origin Rules
        console.log(`[Origin Rules] 正在查找源站规则集...`);
        const rulesetsUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets`;
        const rulesetsRes = await axios.get(rulesetsUrl, { headers });
        const rulesets = rulesetsRes.data.result;
        
        // 寻找到期规则集 phase: http_request_origin
        const originRuleset = rulesets.find(r => r.phase === 'http_request_origin');
        if (!originRuleset) {
            throw new Error(`未在当前 Zone 下找到 http_request_origin 类型的规则集！`);
        }
        
        console.log(`[Origin Rules] 找到目标规则集: ID=${originRuleset.id}, Name=${originRuleset.name}`);
        
        // 获取该规则集的详细规则列表
        const rulesetDetailUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets/${originRuleset.id}`;
        const detailRes = await axios.get(rulesetDetailUrl, { headers });
        const rulesetDetail = detailRes.data.result;
        let rules = rulesetDetail.rules || [];
        
        console.log(`[Origin Rules] 当前共有 ${rules.length} 条源站重写规则`);
        
        // 查找针对 fcn 域名的规则
        let targetRule = rules.find(r => r.expression.includes(TARGET_DOMAIN));
        
        if (!targetRule) {
            console.log(`[Origin Rules] 未找到针对 ${TARGET_DOMAIN} 的现有端口重写规则，正在新建规则对象...`);
            // 创建新的规则对象并追加到数组
            targetRule = {
                expression: `(http.host eq "${TARGET_DOMAIN}")`,
                description: `Port Rewrite for Vless-WS-CDN fcn`,
                action: 'route',
                action_parameters: {
                    origin: {
                        port: NEW_PORT
                    }
                },
                enabled: true
            };
            rules.push(targetRule);
        } else {
            console.log(`[Origin Rules] 找到现有规则: ID=${targetRule.id}, 当前重写端口=${targetRule.action_parameters?.origin?.port || '无'}`);
            if (!targetRule.action_parameters) targetRule.action_parameters = {};
            if (!targetRule.action_parameters.origin) targetRule.action_parameters.origin = {};
            
            // 更新端口
            targetRule.action_parameters.origin.port = NEW_PORT;
            // 清理一些只读字段，以防 PUT 时报错
            delete targetRule.version;
            delete targetRule.modified_on;
            delete targetRule.id;
        }

        // 清理 rules 数组中所有规则的系统只读字段，防止 API 拒绝
        const cleanedRules = rules.map(r => {
            const copy = { ...r };
            delete copy.id;
            delete copy.version;
            delete copy.modified_on;
            return copy;
        });

        console.log(`[Origin Rules] 正在更新源站规则，将回源端口重写为 ${NEW_PORT}...`);
        const updateRulesetUrl = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets/${originRuleset.id}`;
        await axios.put(updateRulesetUrl, {
            rules: cleanedRules
        }, { headers });
        
        console.log(`[Origin Rules] ✅ 源站端口重写规则更新成功！`);
        console.log(`=== [成功] 所有对接任务全部圆满完成！已指向新 IP ${NEW_IP} 并重写端口至 ${NEW_PORT} ===`);
        
    } catch (e) {
        console.error(`\n❌ 执行失败:`);
        if (e.response && e.response.data) {
            console.error(JSON.stringify(e.response.data, null, 2));
        } else {
            console.error(e.message);
        }
    }
}

main();
