// 完整验证：GitHub 上「调 AI 生成回复 → 发到手表」的闭环
const https = require('https');
const { ImClient } = require('../lib/im');

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
          if (t) resolve({ text: String(t).trim() });
          else resolve({ err: (j && j.error && (j.error.message || j.error.code)) || ('http ' + res.statusCode) });
        } catch (e) { resolve({ err: 'parse http ' + res.statusCode }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }); });
    req.on('error', (e) => resolve({ err: e.code || e.message }));
    req.write(body);
    req.end();
  });
}

(async () => {
  // ---------- 第一步：让 AI 生成一句回复 ----------
  const msgs = [
    { role: 'system', content: '你是用户手表上的 AI 助手，对面是个六年级男孩。说话直白、口语、不啰嗦，80 字以内。' },
    { role: 'user', content: '你在吗？给我说句话，证明云端真的活着。' },
  ];
  let reply = '';
  const cf = JSON.parse(process.env.CLOUDFLARE_CONFIG_JSON || '{}');
  if (cf.accountId && cf.apiToken) {
    const p = `/client/v4/accounts/${encodeURIComponent(cf.accountId)}/ai/v1/chat/completions`;
    const r = await post('api.cloudflare.com', p, { Authorization: 'Bearer ' + cf.apiToken },
      { model: cf.model || '@cf/zai-org/glm-4.7-flash', messages: msgs, max_tokens: 300, temperature: 0.6, stream: false, chat_template_kwargs: { enable_thinking: false } }, 35000);
    if (r.text) reply = r.text;
    else console.log('Cloudflare 失败:', r.err);
  }
  if (!reply) { console.log('AI 没生成出内容，退出'); process.exit(3); }
  console.log('AI 生成:', JSON.stringify(reply));

  // ---------- 第二步：连 IM 发出去 ----------
  const cfg = JSON.parse(process.env.IM_CONFIG_JSON || '{}');
  const c = new ImClient(cfg);
  c.on('error', (e) => console.log('IM 错误', e.message));
  await c.connect();
  await new Promise((r) => setTimeout(r, 2500));
  const final = '【云端AI实测】' + reply;
  const r = await c.sendText(211719271, final);
  console.log('发送结果:', JSON.stringify(r));
  await new Promise((x) => setTimeout(x, 1500));
  try { c.sock && c.sock.destroy(); } catch (e) {}
  process.exit(r && r.ok ? 0 : 2);
})().catch((e) => { console.log('异常', e.stack || e.message); process.exit(4); });
