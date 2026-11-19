// 第三轮：① 挖 bilibili.tv 真实接口 ② 试国内第三方B站解析站（借它们的国内IP取播放地址）
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function req(url, headers) {
  return new Promise((res) => {
    let u;
    try { u = new URL(url); } catch (e) { return res({ status: -1, body: 'bad url' }); }
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 12000,
      headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, headers || {}),
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
const TVH = { Referer: 'https://www.bilibili.tv/', Origin: 'https://www.bilibili.tv' };

const probes = [
  // ── ① bilibili.tv 真实接口候选 ──
  ['tv /v2/search/all', 'https://api.bilibili.tv/intl/gateway/web/v2/search/all?keyword=' + encodeURIComponent('晴天') + '&page=1&s=1'],
  ['tv /v2/search/videos', 'https://api.bilibili.tv/intl/gateway/web/v2/search/videos?keyword=' + encodeURIComponent('晴天')],
  ['tv /search/all', 'https://api.bilibili.tv/intl/gateway/web/search/all?keyword=' + encodeURIComponent('晴天')],
  ['tv 首页', 'https://api.bilibili.tv/intl/gateway/web/home?page=1'],
  ['tv 播放列表', 'https://api.bilibili.tv/intl/gateway/web/playlist?ep_id=1'],

  // ── ② 国内第三方解析站（借国内IP拿直链）──
  ['星之阁API', 'https://api.xingzhige.com/API/bilibili/?url=https://www.bilibili.com/video/' + BV],
  ['injahow bparse', 'https://api.injahow.cn/bparse/?av=' + BV + '&format=mp3'],
  ['suyanw', 'https://api.suyanw.cn/api/bilibili/?url=https://www.bilibili.com/video/' + BV],
  ['52vmy', 'https://api.52vmy.cn/api/video/bili?url=https://www.bilibili.com/video/' + BV],
  ['极客解析', 'https://api.geekzx.com/bilibili/?url=https://www.bilibili.com/video/' + BV],
];

(async () => {
  for (const [name, url] of probes) {
    const r = await req(url, TVH);
    const head = String(r.body).slice(0, 200).replace(/\s+/g, ' ');
    console.log(`\n=== ${name} ===`);
    console.log('HTTP', r.status, '|', head);
    // 若是 JSON 且含直链，单独标出来
    if (/"(url|durl|baseUrl|data)"\s*:/.test(r.body) && /\.(mp3|m4a|mp4|flv)/i.test(r.body)) {
      const m = r.body.match(/https?:\/\/[^\s"'\\]+\.(?:mp3|m4a|mp4|flv)[^\s"'\\]*/i);
      if (m) console.log('★ 发现直链:', m[0].slice(0, 130));
    }
  }
})().catch((e) => console.log('异常', e.stack || e.message));
