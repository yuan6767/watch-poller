// 手表 AI 短连接轮询器 —— 跑在 GitHub Actions 上
// 每次执行：连 IM → 拉未读 → 用 AI 回复 → 记录 syncKey → 断开
// Secrets：IM_CONFIG_JSON（设备凭证）、CLOUDFLARE_CONFIG_JSON（主力 AI）、ZHIPU_KEY（兜底 AI）
const fs = require('fs');
const https = require('https');
const path = require('path');
const { ImClient } = require('./lib/im');

const USER_IM_ID = 211719271;          // 手表端（唯一要服务的对象）
const STATE_FILE = path.join(__dirname, 'state.json');
const REPLY_WINDOW_MIN = 6;            // 至少 6 分钟前才回，避免和云主机实时桥接抢答
const MAX_AGE_MIN = 45;                // 超过 45 分钟的不再回，避免把积压的旧消息逐条回复
const COLLECT_MS = 16000;              // 连上后收集消息的时长
const MAX_REPLY = 3;                   // 单次最多回几条，防止刷屏

const sysPrompt = [
  '你是用户手表上的 AI 助手，对面是一个六年级男孩（昵称作者/6767），说话直白、口语、不啰嗦，不用 emoji 之外的装饰。',
  '回答控制在 150 字以内，手表屏幕小，越短越好。',
  '如果对方问「你在吗/还活着吗」，直接说「我在，这条是从云端回的」。',
  '你只能聊天，做不到发视频、打开软件、查云主机进程、点歌这些，做不到就直接说做不到，别编。',
].join('');

function log(...a) { console.log(new Date().toISOString(), ...a); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(o) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(o, null, 2)); } catch (e) { log('state 写入失败', e.message); }
}

function postJson(host, p, headers, obj, timeout = 30000) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(obj));
    const req = https.request({
      host, path: p, method: 'POST', timeout,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': body.length }, headers || {}),
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (t) resolve({ text: clean(String(t)) });
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

function clean(t) {
  return String(t)
    .replace(/\*\*/g, '').replace(/`/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function readJsonEnv(name) {
  try { return JSON.parse(process.env[name] || '{}') || {}; } catch (e) { return {}; }
}

async function askAI(text) {
  const messages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text },
  ];

  // 1) Cloudflare Workers AI —— 美国节点，GitHub runner 访问快
  const cf = readJsonEnv('CLOUDFLARE_CONFIG_JSON');
  if (cf.accountId && cf.apiToken) {
    const p = `/client/v4/accounts/${encodeURIComponent(cf.accountId)}/ai/v1/chat/completions`;
    const r = await postJson('api.cloudflare.com', p,
      { Authorization: 'Bearer ' + String(cf.apiToken) },
      { model: cf.model || '@cf/zai-org/glm-4.7-flash', messages, max_tokens: 400, temperature: 0.5, stream: false, chat_template_kwargs: { enable_thinking: false } },
      32000);
    if (r.text) return { via: 'cloudflare', text: r.text };
    log('Cloudflare 失败', r.err || '');
    if (cf.model8) {
      const r8 = await postJson('api.cloudflare.com', p,
        { Authorization: 'Bearer ' + String(cf.apiToken) },
        { model: cf.model8, messages, max_tokens: 400, temperature: 0.5, stream: false },
        32000);
      if (r8.text) return { via: 'cloudflare8', text: r8.text };
      log('Cloudflare 备用模型失败', r8.err || '');
    }
  }

  // 2) 智谱兜底
  const zkey = (process.env.ZHIPU_KEY || '').trim();
  if (zkey) {
    for (const model of ['glm-4.7-flash', 'glm-4-flash']) {
      const r = await postJson('open.bigmodel.cn', '/api/paas/v4/chat/completions',
        { Authorization: 'Bearer ' + zkey },
        { model, messages, max_tokens: 400, temperature: 0.6 }, 25000);
      if (r.text) return { via: 'zhipu/' + model, text: r.text };
      log('智谱失败', model, r.err || '');
    }
  }

  return { err: 'all channels failed' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cfgRaw = process.env.IM_CONFIG_JSON || '';
  if (!cfgRaw) { log('缺少 IM_CONFIG_JSON'); process.exit(1); }
  let cfg;
  try { cfg = JSON.parse(cfgRaw); } catch (e) { log('IM_CONFIG_JSON 解析失败'); process.exit(1); }

  const st = loadState();
  cfg.imSyncKey = Number(process.env.FORCE_SYNC_KEY || st.imSyncKey || cfg.imSyncKey || 0);

  // 云主机心跳：新鲜 → 云主机在线 → 只消费不回复，避免重复答话
  let hostAlive = false;
  const hbUrl = process.env.HOST_HB_URL || '';
  const gtoken = (process.env.GITHUB_TOKEN || '').trim();
  log('心跳配置 hbUrl=', hbUrl ? '有' : '无', ' token=', gtoken ? '有(' + gtoken.length + ')' : '无');
  if (hbUrl && gtoken) {
    const r = await new Promise((resolve) => {
      const req = https.get(hbUrl, { headers: { Authorization: 'Bearer ' + gtoken, Accept: 'application/vnd.github.raw', 'User-Agent': 'watch-poller/1.0' }, timeout: 10000 }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, d }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, d: 'timeout' }); });
      req.on('error', (e) => resolve({ status: 0, d: e.code || e.message }));
    });
    log('心跳 HTTP', r.status, ' body=', JSON.stringify(String(r.d).slice(0, 120)));
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.d);
        const age = Date.now() - new Date(j.ts).getTime();
        hostAlive = Number.isFinite(age) && age < 12 * 60 * 1000;
        log('云主机心跳距今', Math.round(age / 1000) + 's，在线=', hostAlive);
      } catch (e) { log('心跳解析失败', e.message); }
    }
  }

  const c = new ImClient(cfg);
  const got = [];
  c.on('message', (m) => {
    try {
      if (Number(m.imAccountId) === Number(c.imAccountId)) return;
      if (String(m.dialogId || '').startsWith('g:')) return;
      if (Number(m.imAccountId) !== USER_IM_ID) return;
      const body = m.body || {};
      const text = String(body.text || '').trim();
      if (!text) return;
      if (/收到一条表情消息|版本升级后可查看|APP版本过低|版本过低|不支持查看/.test(text)) return;
      got.push({ msgId: m.msgId, text, ts: m.createTime || 0 });
      log('收到', JSON.stringify(text.slice(0, 40)));
    } catch (e) { log('消息解析异常', e.message); }
  });
  c.on('error', (e) => log('IM 错误', e.message));

  log('连接 IM…', '起始 syncKey=', cfg.imSyncKey);
  try { await c.connect(); } catch (e) { log('连接失败', e.message); process.exit(3); }
  log('已上线，开始多轮拉取未读');

  let lastKey = -1;
  for (let i = 0; i < 6; i++) {
    try { await c.sync(); } catch (e) { log('sync 异常', e.message); }
    await sleep(4000);
    if (c.syncKey === lastKey) break;
    lastKey = c.syncKey;
  }
  await sleep(COLLECT_MS - 4000 * 2);

  const nowSec = Math.floor(Date.now() / 1000);
  const ripe = got.filter((x) => {
    const age = x.ts ? (nowSec - x.ts) / 60 : 999;
    return x.ts ? (age >= REPLY_WINDOW_MIN && age <= MAX_AGE_MIN) : false;
  });
  log('本轮收到', got.length, '条；落在可回窗口内', ripe.length, '条；云主机在线=', hostAlive);

  if (ripe.length && !hostAlive) {
    for (const m of ripe.slice(-MAX_REPLY)) {
      const r = await askAI(m.text);
      if (r.text) {
        try {
          await c.sendText(USER_IM_ID, r.text);
          log('已回（' + r.via + '）', JSON.stringify(r.text.slice(0, 40)));
        } catch (e) { log('回发失败', e.message); }
        await sleep(1200);
      } else {
        log('AI 全线失败', r.err || '');
      }
    }
  } else if (hostAlive) {
    log('云主机在线，跳过回复（消息仍已消费）');
  }

  const nextKey = Number(c.syncKey || cfg.imSyncKey || 0);
  saveState({ imSyncKey: nextKey, updated: new Date().toISOString(), got: got.length, ripe: ripe.length, hostAlive });
  log('结束，syncKey', cfg.imSyncKey, '->', nextKey);

  try { c.sock && c.sock.destroy(); } catch (e) {}
  process.exit(0);
})().catch((e) => { log('未捕获异常', e.stack || e.message); process.exit(4); });
