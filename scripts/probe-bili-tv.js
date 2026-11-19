// 测 B站海外版 bilibili.tv 的独立接口（不受国内 IP 风控影响？）
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function req(url, headers) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 15000,
      headers: Object.assign({ Accept: 'application/json, text/plain, */*' }, headers || {}),
    }, (rs) => {
      let d = ''; rs.on('data', (c) => (d += c));
      rs.on('end', () => res({ status: rs.statusCode, body: d }));
    });
    r.on('timeout', () => { r.destroy(); res({ status: 0, body: 'timeout' }); });
    r.on('error', (e) => res({ status: 0, body: e.code || e.message }));
    r.end();
  });
}

(async () => {
  const H = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.tv/',
    Origin: 'https://www.bilibili.tv',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };

  const probes = [
    ['海外版 搜索 v1', 'https://api.bilibili.tv/intl/gateway/web/search?keyword=' + encodeURIComponent('晴天') + '&s=1&page=1'],
    ['海外版 搜索 v2', 'https://api.bilibili.tv/intl/gateway/web/v2/search/all?keyword=' + encodeURIComponent('晴天')],
    ['海外版 首页推荐', 'https://api.bilibili.tv/intl/gateway/web/home'],
    ['国内 评论区(换接口试)', 'https://api.bilibili.com/x/v2/reply?type=1&oid=170001&pn=1'],
    ['网易云 歌曲直链', 'https://music.163.com/api/song/enhance/player/url?id=186016&ids=%5B186016%5D&br=128000'],
  ];

  for (const [name, url] of probes) {
    const r = await req(url, H);
    const head = r.body.slice(0, 160).replace(/\s+/g, ' ');
    console.log(`\n=== ${name} ===`);
    console.log('HTTP', r.status, '|', head);
  }
})().catch((e) => console.log('异常', e.stack || e.message));
