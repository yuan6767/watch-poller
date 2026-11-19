// GitHub Actions 连通性自检
// 目的：确认 GitHub 的机器能不能连上小天才 IM 服务器和智谱 AI
const net = require('net');
const https = require('https');

function tcp(host, port, timeout = 8000) {
  return new Promise((res) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const finish = (ok, msg) => {
      try { s.destroy(); } catch (e) {}
      res({ host, port, ok, ms: Date.now() - t0, msg });
    };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true, 'TCP 握手成功'));
    s.once('timeout', () => finish(false, '超时'));
    s.once('error', (e) => finish(false, e.code || e.message));
  });
}

function httpGet(url) {
  return new Promise((res) => {
    const req = https.get(url, { timeout: 10000 }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res({ ok: true, status: r.statusCode, body: d.slice(0, 200) }));
    });
    req.on('timeout', () => { req.destroy(); res({ ok: false, msg: '超时' }); });
    req.on('error', (e) => res({ ok: false, msg: e.code || e.message }));
  });
}

function httpPostJson(host, path, headers, bodyObj) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify(bodyObj));
    const req = https.request({
      host, path, method: 'POST', timeout: 20000,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': body.length }, headers || {}),
    }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res({ status: r.statusCode, body: d.slice(0, 400) }));
    });
    req.on('timeout', () => { req.destroy(); res({ error: '超时' }); });
    req.on('error', (e) => res({ error: e.code || e.message }));
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('=== 1. GitHub runner 出口 IP ===');
  const ip = await httpGet('https://ifconfig.me/ip');
  console.log(ip.ok ? ip.body.trim() : '取不到: ' + ip.msg);

  console.log('\n=== 2. 小天才 IM 服务器 im3.okii.com:8002 ===');
  const im = await tcp('im3.okii.com', 8002);
  console.log(JSON.stringify(im));

  console.log('\n=== 3. 智谱 AI open.bigmodel.cn:443 ===');
  const zp = await tcp('open.bigmodel.cn', 443);
  console.log(JSON.stringify(zp));

  console.log('\n=== 4. 智谱真调一次（验证 key 在 GitHub 上可用） ===');
  const zkey = (process.env.ZHIPU_KEY || '').trim();
  if (!zkey) {
    console.log('未提供 ZHIPU_KEY secret，跳过');
  } else {
    const r = await httpPostJson(
      'open.bigmodel.cn',
      '/api/paas/v4/chat/completions',
      { Authorization: 'Bearer ' + zkey },
      { model: 'glm-4.7-flash', messages: [{ role: 'user', content: '只回两个字：可用' }], max_tokens: 20 }
    );
    console.log('HTTP', r.status || r.error);
    console.log(String(r.body || '').slice(0, 300));
  }

  const okAll = im.ok && zp.ok;
  console.log('\n=== 结论 ===');
  console.log(okAll ? '✅ IM 与 AI 都通，方案可行' : '❌ 有不通的，需要另想办法');
  process.exit(okAll ? 0 : 1);
})();
