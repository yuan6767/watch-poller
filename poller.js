// 手表 AI 短连接轮询器 —— 跑在 GitHub Actions 上
// 每次执行：连 IM → 拉未读 → 用 AI 回复 → 记录 syncKey → 断开
// Secrets：IM_CONFIG_JSON（设备凭证）、CLOUDFLARE_CONFIG_JSON（主力 AI）、ZHIPU_KEY（兜底 AI）
const fs = require('fs');
const https = require('https');
const path = require('path');
const { ImClient } = require('./lib/im');

const USER_IM_ID = 211719271;          // 手表端（唯一要服务的对象）
const STATE_FILE = path.join(__dirname, 'state.json');
const PROMPT_FILE = path.join(__dirname, 'sys_prompt.txt');
const REPLY_WINDOW_MIN = 6;            // 至少 6 分钟前才回，避免和云主机实时桥接抢答
const MAX_AGE_MIN = 90;                // 超过 90 分钟的不再回，避免把积压的旧消息逐条回复
const COLLECT_MS = 16000;              // 连上后收集消息的时长
const MAX_REPLY = 3;                   // 单次最多回几条，防止刷屏
const FORCE_MINUTES = 60;   // /切换 后云端强制接管多久（和本地暂停时长保持一致）              // /切换 后云端强制接管多久

// —— 和云主机桥接完全同源的人设，外加云端通道的能力边界补充 ——
let sysPrompt = '你是手表上的AI智能体。用户是六年级男生，叫六七，六九班，喜欢软硬件折腾。';
try {
  sysPrompt = fs.readFileSync(PROMPT_FILE, 'utf8');
} catch (e) {
  console.log('读人设文件失败，用简版', e.message);
}
sysPrompt += '\n【云端通道补充】你现在跑在云端，只能发纯文字。发视频、点歌、画图、查电脑进程、开关软件这些你都做不到，有人问就直接说现在做不到，别编、别装作做了。';

// —— 斜杠命令 ——
const SWITCH_RE = /^[\/／]\s*(切换|切到云端|云端|switch|cloud)\s*$/i;
const BACK_RE = /^[\/／]\s*(切回|切回本地|本地|back|local)\s*$/i;
const HELP_RE = /^[\/／]\s*(help|帮助|命令)\s*$/i;

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
  let s = String(t)
    .replace(/^[\s\S]*?<\/[^>]*think[^>]*>/i, '')
    .replace(/<\/?[^>]*think[^>]*>/gi, '')
    .replace(/\*\*/g, '').replace(/`/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g, '')
    .replace(/([^。！？!?\n]{4,40}[。！？!?])(?:\s*\1)+/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
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
  // 例外：用户发过 /切换，forceCloudUntil 未过期 → 不管云主机活不活都由云端接
  let hostAlive = false;
  let hbAgeMs = null;
  const hbUrl = process.env.HOST_HB_URL || '';
  const gtoken = (process.env.GITHUB_TOKEN || '').trim();
  if (hbUrl && gtoken) {
    const r = await new Promise((resolve) => {
      const req = https.get(hbUrl, { headers: { Authorization: 'Bearer ' + gtoken, Accept: 'application/vnd.github.raw', 'User-Agent': 'watch-poller/1.0' }, timeout: 10000 }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, d }));
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, d: 'timeout' }); });
      req.on('error', (e) => resolve({ status: 0, d: e.code || e.message }));
    });
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.d);
        const age = Date.now() - new Date(j.ts).getTime();
        hbAgeMs = Number.isFinite(age) ? age : null;
        // 心跳里的 bridge 字段必须为 true 才算在线：容器活着但桥接死了时，
        // hb_push 仍会每 5 分钟刷新 ts，只看时间会让 GitHub 永远不接管。
        const bridgeOk = j.bridge !== false;
        hostAlive = Number.isFinite(age) && age < 7 * 60 * 1000 && bridgeOk;
        log('云主机心跳距今', Math.round(age / 1000) + 's，bridge=' + (bridgeOk ? 'true' : 'false') + '，在线=', hostAlive);
      } catch (e) { log('心跳解析失败', e.message); }
    } else {
      log('心跳读失败', r.status, String(r.d).slice(0, 80));
    }
  }

  // 云端心跳停了 ≥15 分钟 → 判为「云端炸了」，每 2 小时最多喊一次
  let dieNotice = false;
  if (!hostAlive && hbAgeMs !== null && hbAgeMs > 15 * 60 * 1000) {
    const lastDie = Number(st.lastDieNotice || 0);
    if (Date.now() - lastDie > 2 * 60 * 60 * 1000) dieNotice = true;
    log('云端炸了判定：心跳停了', Math.round(hbAgeMs / 1000) + 's，本轮是否播报=', dieNotice);
  }

  let forceUntil = Number(st.forceCloudUntil || 0);
  const forced = forceUntil > Date.now();
  log('强制接管状态：', forced ? ('开，剩 ' + Math.round((forceUntil - Date.now()) / 60000) + ' 分钟') : '关');

  // ★关键：本地在线、又没被要求接管时，一轮都不连 IM。
  // 以前每轮都连、都 sync，会把消息从服务端「读走」并推进 syncKey，
  // 结果桥接再上线就永远收不到那条了 —— 用户看到的「发了没人回」就是这么来的。
  if (hostAlive && !forced) {
    log('本地在线且没要求强制接管，本轮不连 IM（消息留给桥接）');
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign({}, st, { updated: new Date().toISOString(), hostAlive, forceCloudUntil: 0 }), null, 2)); } catch (e) {}
    process.exit(0);
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

  let lastKey = -1;
  for (let i = 0; i < 6; i++) {
    try { await c.sync(); } catch (e) { log('sync 异常', e.message); }
    await sleep(4000);
    if (c.syncKey === lastKey) break;
    lastKey = c.syncKey;
  }
  await sleep(Math.max(2000, COLLECT_MS - 4000 * 6));

  // 云端炸了的预告：连上 IM 先喊一条，再走正常流程
  if (dieNotice) {
    try {
      await c.sendText(USER_IM_ID, '⚠️ 云端炸了：云主机心跳停了十几分钟，我现在是 GitHub 备用通道。文字能收发，发图/视频/点歌/看电脑这些做不了。云端恢复后自动交还。这条每 2 小时最多发一次。');
      log('已发「云端炸了」预告');
      st.lastDieNotice = Date.now();
    } catch (e) { log('预告发送失败', e.message); }
    await sleep(1500);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const withinWindow = (x) => {
    if (!x.ts) return false;
    const ageMin = (nowSec - x.ts) / 60;
    return ageMin <= MAX_AGE_MIN;
  };

  // —— 第一优先：斜杠命令（只要在 45 分钟窗口内，立刻执行，不等 minAge）——
  let handled = false;
  const cmdMsgs = got.filter((x) => withinWindow(x) && (SWITCH_RE.test(x.text) || BACK_RE.test(x.text) || HELP_RE.test(x.text)));
  if (cmdMsgs.length) {
    const m = cmdMsgs[cmdMsgs.length - 1];
    try {
      if (SWITCH_RE.test(m.text)) {
        forceUntil = Date.now() + FORCE_MINUTES * 60 * 1000;
        await c.sendText(USER_IM_ID, '收到，云端接管 ' + FORCE_MINUTES + ' 分钟。这段时间不管本地通不通，都由我来回你。想还回去就发 /切回。');
        log('命令执行：切到云端', FORCE_MINUTES + '分钟');
      } else if (BACK_RE.test(m.text)) {
        forceUntil = 0;
        await c.sendText(USER_IM_ID, '好，交回本地了。本地通道可能要等一会儿才彻底回来，这期间还是我陪你。');
        log('命令执行：切回本地');
      } else {
        await c.sendText(USER_IM_ID, '可用命令：\n/切换 — 让云端接管 ' + FORCE_MINUTES + ' 分钟\n/切回 — 交还本地通道\n/help — 看这个');
        log('命令执行：帮助');
      }
      handled = true;
      await sleep(1200);
    } catch (e) { log('命令回复失败', e.message); }
  }

  const forceNow = forceUntil > Date.now();

  // —— 第二优先：普通消息 ——
  const minAge = (hostAlive && !forceNow) ? REPLY_WINDOW_MIN : 0.1;   // 接管模式下立刻回，不再避让
  const ripe = got.filter((x) => withinWindow(x) && !(SWITCH_RE.test(x.text) || BACK_RE.test(x.text) || HELP_RE.test(x.text)))
    .filter((x) => {
      const age = (nowSec - x.ts) / 60;
      return age >= minAge;
    });

  log('本轮收到', got.length, '条；可回', ripe.length, '条；云主机在线=', hostAlive, '强制接管=', forceNow, '已处理命令=', handled);

  if (ripe.length && (!hostAlive || forceNow)) {
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
  } else if (hostAlive && !forceNow && ripe.length) {
    log('云主机在线，跳过回复（消息仍已消费）');
  }

  const nextKey = Number(c.syncKey || cfg.imSyncKey || 0);
  saveState(Object.assign({}, st, {
    imSyncKey: nextKey,
    updated: new Date().toISOString(),
    got: got.length,
    ripe: ripe.length,
    hostAlive,
    forceCloudUntil: forceUntil,
  }));
  log('结束，syncKey', cfg.imSyncKey, '->', nextKey);

  try { c.sock && c.sock.destroy(); } catch (e) {}
  process.exit(0);
})().catch((e) => { log('未捕获异常', e.stack || e.message); process.exit(4); });
