// 第四轮：不走 API，直接抓 B站视频网页 HTML，里面的 window.__playinfo__ 自带完整音频直链
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function req(url, headers) {
  return new Promise((res) => {
    let u; try { u = new URL(url); } catch (e) { return res({ status: -1, body: 'bad' }); }
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 18000,
      headers: Object.assign({ 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' }, headers || {}),
    }, (rs) => {
      let d = ''; rs.on('data', (c) => (d += c));
      rs.on('end', () => res({ status: rs.statusCode, body: d }));
    });
    r.on('timeout', () => { r.destroy(); res({ status: 0, body: 'timeout' }); });
    r.on('error', (e) => res({ status: 0, body: e.code || e.message }));
    r.end();
  });
}

const BV = 'BV1BZbSzZEGT';

async function tryPage(name, headers) {
  console.log(`\n=== ${name} ===`);
  const r = await req('https://www.bilibili.com/video/' + BV, headers);
  console.log('HTTP', r.status, ' HTML长度', r.body.length);

  const m = r.body.match(/window\.__playinfo__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
  if (!m) {
    console.log('没找到 __playinfo__，前 120 字:', r.body.slice(0, 120).replace(/\s+/g, ' '));
    return;
  }
  try {
    const j = JSON.parse(m[1]);
    const d = j.data || {};
    const dash = d.dash || {};
    const audios = dash.audio || [];
    console.log('code:', j.code, ' 视频标题:', (d.title || '?').slice(0, 30));
    console.log('音频流数量:', audios.length);
    if (audios[0]) {
      console.log('★ 音频直链前 110 字:', audios[0].baseUrl.slice(0, 110));
      console.log('=== 实测下载前 200KB ===');
      const dl = await req(audios[0].baseUrl, { Referer: 'https://www.bilibili.com/video/' + BV });
      console.log('下载 HTTP', dl.status, ' 收到字节', dl.body.length);
    }
  } catch (e) { console.log('解析失败', e.message, m[1].slice(0, 120)); }
}

(async () => {
  await tryPage('PC 版网页', { Referer: 'https://www.bilibili.com/' });
  await tryPage('手机版网页', { 'User-Agent': UA_M, Referer: 'https://www.bilibili.com/' });
})().catch((e) => console.log('异常', e.stack || e.message));
