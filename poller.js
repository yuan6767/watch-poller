// 手表 AI 短连接轮询器 —— 跑在 GitHub Actions 上
// 每次执行：连 IM → 拉未读 → 用 AI 回复 → 记录 syncKey → 断开
// 依赖 secrets：IM_CONFIG_JSON（设备凭证）、ZHIPU_KEY（智谱 key）、GUARD_HB（云主机心跳判定，可选）
const fs = require('fs');
const https = require('https');
const path = require('path');
const ImClient = require('./lib/im');

const USER_IM_ID = 211719271;          // 手表端（唯一要服务的对象）
const STATE_FILE = path.join(__dirname, 'state.json');
const REPLY_WINDOW_MIN = 6;            // 只回 6 分钟以前的消息，避免和云主机实时桥接抢答
const COLLECT_MS = 15000;              // 连上后收集消息的时长
const MAX_REPLY = 3;                   // 单次最多回几条，防止刷屏
const ZHIPU_MODEL = 'glm-4.7-flash';
const ZHIPU_BACKUP = 'glm-4-flash';

const sysPrompt = [
  '你是用户手表上的 AI 助手，对面是一个六年级男孩（昵称作者/6767），说话要直白、口语、别啰嗦，不用 emoji 之外的装饰。',
  '回答控制在 200 字以内，手表屏幕小，能短就短。',
  '你不知道云主机现在是否在线，如果对方问「你在吗/还活着吗」，直接说「我在，这条是从云端回的」。',
  '不要编造你做不到的事（例如发视频、打开软件、查云主机进程），做不到就直接说这次做不到。',
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
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ _raw: d }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.write(body);
    req.end();
  });
}

async function askAI(text) {
  const key = (process.env.ZHIPU_KEY || '').trim();
  if (!key) return { err: 'no key' };
  const messages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: text },
  ];
  for (const model of [ZHIPU_MODEL, ZHIPU_BACKUP]) {
    const r = await postJson('open.bigmodel.cn', '/api/paas/v4/chat/completions',
      { Authorization: 'Bearer ' + key },
      { model, messages, max_tokens: 400, temperature: 0.6 }, 28000);
    const t = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
    if (t) return { text: String(t).replace(/\*\*/g, '').replace(/`/g, '').trim() };
    log('模型失败', model, JSON.stringify(r).slice(0, 120));
  }
  return { err: 'all models failed' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cfgRaw = process.env.IM_CONFIG_JSON || '';
  if (!cfgRaw) { log('缺少 IM_CONFIG_JSON'); process.exit(1); }
  let cfg;
  try { cfg = JSON.parse(cfgRaw); } catch (e) { log('IM_CONFIG_JSON 解析失败'); process.exit(1); }

  const st = loadState();
  const startKey = Number(process.env.FORCE_SYNC_KEY || st.imSyncKey || cfg.imSyncKey || 0);
  cfg.imSyncKey = startKey;

  // 云主机心跳判定：心跳新 → 云主机在线 → 本脚本只消费不回复，避免重复答话
  let hostAlive = false;
  const hbUrl = process.env.HOST_HB_URL || '';
  if (hbUrl) {
    try {
      if ((process.env.GITHUB_TOKEN || '').trim()) {
        const r = await new Promise((resolve) => {
          const req = https.get(hbUrl, {
            headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github.raw' },
            timeout: 10000,
          }, (res) => {
            let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, d }));
          });
          req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
          req.on('error', () => resolve({ status: 0 }));
        });
        if (r.status === 200) {
          const j = JSON.parse(r.d);
          const age = Date.now() - new Date(j.ts).getTime();
          hostAlive = Number.isFinite(age) && age < 12 * 60 * 1000;
          log('云主机心跳距今', Math.round(age / 1000) + 's', '判定在线=', hostAlive);
        }
      }
    } catch (e) { log('心跳读取失败', e.message); }
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
      got.push({ msgId: m.msgId, text, ts: m.createTime || 0, at: Date.now() });
      log('收到', JSON.stringify(text.slice(0, 40)));
    } catch (e) { log('消息解析异常', e.message); }
  });
  c.on('error', (e) => log('IM 错误', e.message));

  log('连接 IM…', '起始 syncKey=', cfg.imSyncKey);
  try { await c.connect(); } catch (e) { log('连接失败', e.message); process.exit(3); }
  log('已上线，拉取未读');
  try { await c.sync(); } catch (e) { log('sync 调用异常', e.message); }
  await sleep(COLLECT_MS);

  // 只回「发出来超过 REPLY_WINDOW_MIN 分钟」的消息：更近的交给云主机实时桥接
  const nowSec = Math.floor(Date.now() / 1000);
  const ripe = got.filter((x) => {
    if (!x.ts) return true;
    return nowSec - x.ts >= REPLY_WINDOW_MIN * 60;
  });
  log('本轮收到', got.length, '条，其中可回', ripe.length, '条，云主机在线=', hostAlive);

  if (ripe.length && !hostAlive) {
    const list = ripe.slice(-MAX_REPLY);
    for (const m of list) {
      const r = await askAI(m.text);
      if (r.text) {
        try { await c.sendText(USER_IM_ID, r.text); log('已回', JSON.stringify(r.text.slice(0, 40))); } catch (e) { log('回发失败', e.message); }
        await sleep(1200);
      } else {
        log('AI 未给出内容', r.err || '');
      }
    }
  } else if (hostAlive) {
    log('云主机在线，跳过回复（消息仍已消费）');
  }

  const nextKey = Number(c.syncKey || cfg.imSyncKey || 0);
  saveState({ imSyncKey: nextKey, updated: new Date().toISOString(), lastCount: got.length, hostAlive });
  log('结束，syncKey', cfg.imSyncKey, '->', nextKey);

  try { c.sock && c.sock.destroy(); } catch (e) {}
  process.exit(0);
})().catch((e) => { log('未捕获异常', e.message); process.exit(4); });
