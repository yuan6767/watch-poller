// 验证 GitHub Actions 上 AI 能不能正常应答（Cloudflare 主力 + 智谱兜底）
const https = require('https');

function post(host, p, headers, obj, timeout = 30000) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(obj));
    const req = https.request({
      host, path: p, method: 'POST', timeout,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': body.length, 'User-Agent': 'watch-poller/1.0' }, headers || {}),
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (t) resolve({ text: String(t).trim().slice(0, 200) });
          else resolve({ err: (j && j.error && (j.error.message || j.error.code)) || ('http ' + res.statusCode + ' ' + d.slice(0, 150)) });
        } catch (e) { resolve({ err: 'parse http ' + res.statusCode + ' ' + d.slice(0, 120) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout ' + timeout + 'ms' }); });
    req.on('error', (e) => resolve({ err: e.code || e.message }));
    req.write(body);
    req.end();
  });
}

(async () => {
  const msgs = [
    { role: 'system', content: '你是手表上的 AI 助手，说话直白简短，100 字以内。' },
    { role: 'user', content: '你在吗？用一句话回我。' },
  ];
  const cf = JSON.parse(process.env.CLOUDFLARE_CONFIG_JSON || '{}');
  console.log('Cloudflare 配置:', cf.accountId ? '有 accountId' : '无', '|', cf.apiToken ? '有 token' : '无', '| model=', cf.model);

  if (cf.accountId && cf.apiToken) {
    const path = `/client/v4/accounts/${encodeURIComponent(cf.accountId)}/ai/v1/chat/completions`;
    const t0 = Date.now();
    const r = await post('api.cloudflare.com', path, { Authorization: 'Bearer ' + cf.apiToken },
      { model: cf.model || '@cf/zai-org/glm-4.7-flash', messages: msgs, max_tokens: 300, temperature: 0.5, stream: false, chat_template_kwargs: { enable_thinking: false } }, 35000);
    console.log(`[1] Cloudflare ${Date.now() - t0}ms →`, JSON.stringify(r));
    if (r.text) { console.log('✅ Cloudflare 可用'); process.exit(0); }

    const t1 = Date.now();
    const r8 = await post('api.cloudflare.com', path, { Authorization: 'Bearer ' + cf.apiToken },
      { model: cf.model8, messages: msgs, max_tokens: 300, temperature: 0.5, stream: false }, 35000);
    console.log(`[2] Cloudflare 备用 ${Date.now() - t1}ms →`, JSON.stringify(r8));
    if (r8.text) { console.log('✅ Cloudflare 备用模型可用'); process.exit(0); }
  }

  const zk = (process.env.ZHIPU_KEY || '').trim();
  if (zk) {
    const t2 = Date.now();
    const r = await post('open.bigmodel.cn', '/api/paas/v4/chat/completions', { Authorization: 'Bearer ' + zk },
      { model: 'glm-4-flash', messages: msgs, max_tokens: 300, temperature: 0.6 }, 25000);
    console.log(`[3] 智谱 ${Date.now() - t2}ms →`, JSON.stringify(r));
    if (r.text) { console.log('✅ 智谱可用'); process.exit(0); }
  }

  console.log('❌ 所有 AI 通道都不可用');
  process.exit(1);
})();
