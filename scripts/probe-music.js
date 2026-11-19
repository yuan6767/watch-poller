// 测网易云「外链播放」接口从美国 IP 能否拿到真实 mp3 直链
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function req(url, headers, maxBytes) {
  return new Promise((res) => {
    let u; try { u = new URL(url); } catch (e) { return res({ status: -1, body: '', bytes: 0 }); }
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 15000,
      headers: Object.assign({ 'User-Agent': UA }, headers || {}),
    }, (rs) => {
      let d = ''; let n = 0;
      rs.on('data', (c) => {
        n += c.length;
        if (maxBytes && n >= maxBytes) { r.destroy(); res({ status: rs.statusCode, body: d, bytes: n }); return; }
        if (!maxBytes) d += c;
      });
      rs.on('end', () => res({ status: rs.statusCode, body: d, bytes: n }));
      rs.on('error', () => res({ status: rs.statusCode, body: d, bytes: n }));
    });
    r.on('timeout', () => { r.destroy(); res({ status: 0, body: 'timeout', bytes: 0 }); });
    r.on('error', (e) => res({ status: 0, body: e.code || e.message, bytes: 0 }));
    r.end();
  });
}

(async () => {
  console.log('=== 出口 IP ===');
  const ip = await req('https://api.ipify.org', {});
  console.log(ip.status, ip.body.slice(0, 40));

  const ids = [347222, 1813734931, 186016, 1901371647];
  for (const id of ids) {
    console.log(`\n=== 歌曲 ${id} 的外链 ===`);
    const r = await req(`https://music.163.com/song/media/outer/url?id=${id}.mp3`, { Referer: 'https://music.163.com/' }, 400000);
    console.log('HTTP', r.status, ' 拿到字节', r.bytes);
    if (r.status === 302 || r.status === 301) console.log('  重定向到:', (r.body || '').slice(0, 100));
    // 跟随重定向（Node 不会自动跟随，手工再请求一次拿 location）
  }

  // 手工跟随一次 302，看看最终能不能真下到音频
  console.log('\n=== 手工跟随 347222 的 302 ===');
  const r1 = await req('https://music.163.com/song/media/outer/url?id=347222.mp3', { Referer: 'https://music.163.com/' }, 0);
  // 用 HEAD 拿 location
  await new Promise((done) => {
    const u = new URL('https://music.163.com/song/media/outer/url?id=347222.mp3');
    const rq = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'HEAD',
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' }, timeout: 12000 }, (rs) => {
      console.log('HEAD status:', rs.statusCode, ' location:', String(rs.headers.location || '').slice(0, 110));
      rs.resume(); rs.on('end', done);
    });
    rq.on('timeout', () => { rq.destroy(); done(); });
    rq.on('error', () => done());
    rq.end();
  });
})().catch((e) => console.log('异常', e.stack || e.message));
