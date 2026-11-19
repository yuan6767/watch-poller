// 第二轮：给 B站接口补 wbi 签名（2023 年后官方加的反爬机制），再试取视频详情和音频流
const crypto = require('crypto');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REF = 'https://www.bilibili.com/';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const mixinKey = (orig) => MIXIN_TAB.map((n) => orig[n]).join('').slice(0, 32);

function encWbi(params, imgKey, subKey) {
  const mk = mixinKey(imgKey + subKey);
  params.wts = Math.round(Date.now() / 1000);
  const q = Object.keys(params).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return q + '&w_rid=' + md5(q + mk);
}

function req(url, headers) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 15000,
      headers: Object.assign({ Accept: '*/*' }, headers || {}),
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
  const CK = (process.env.BILI_COOKIE || '').trim();
  const H = { 'User-Agent': UA, Referer: REF, Cookie: CK };

  console.log('=== 1 拿 wbi 密钥 ===');
  const nav = await req('https://api.bilibili.com/x/web-interface/nav', H);
  let imgKey = '', subKey = '';
  try {
    const j = JSON.parse(nav.body);
    const w = j.data && j.data.wbi_img;
    if (w) {
      imgKey = w.img_url.split('/').pop().split('.')[0];
      subKey = w.sub_url.split('/').pop().split('.')[0];
    }
    console.log('nav code:', j.code, ' imgKey:', imgKey, ' subKey:', subKey);
  } catch (e) { console.log('nav 解析失败', nav.status, nav.body.slice(0, 120)); }

  if (!imgKey) { console.log('拿不到密钥，退出'); return; }

  const bvid = process.env.TEST_BVID || 'BV1BZbSzZEGT';

  console.log('\n=== 2 带签名取视频详情 ===');
  const qv = encWbi({ bvid }, imgKey, subKey);
  const v = await req(`https://api.bilibili.com/x/web-interface/view?${qv}`, H);
  let cid = 0;
  try {
    const j = JSON.parse(v.body);
    cid = j.data && j.data.pages && j.data.pages[0] && j.data.pages[0].cid;
    console.log('status:', v.status, ' code:', j.code, ' 标题:', ((j.data && j.data.title) || '').slice(0, 40), ' cid:', cid);
  } catch (e) { console.log('view 失败', v.status, v.body.slice(0, 150)); }

  if (!cid) { console.log('拿不到 cid，停在这里'); return; }

  console.log('\n=== 3 带签名取播放地址（音频流）===');
  const qp = encWbi({ bvid, cid, fnval: 16, fourk: 1 }, imgKey, subKey);
  const p = await req(`https://api.bilibili.com/x/player/playurl?${qp}`, Object.assign({}, H, { Referer: 'https://www.bilibili.com/video/' + bvid }));
  try {
    const j = JSON.parse(p.body);
    const dash = j.data && j.data.dash;
    const audios = (dash && dash.audio) || [];
    console.log('status:', p.status, ' code:', j.code, ' 音频流数量:', audios.length);
    if (audios[0]) {
      console.log('首个音频 baseUrl 前 100 字:', audios[0].baseUrl.slice(0, 100));
      console.log('=== 4 真去下这个音频流的前 200KB ===');
      const dl = await req(audios[0].baseUrl, { 'User-Agent': UA, Referer: 'https://www.bilibili.com/video/' + bvid, Cookie: CK });
      console.log('下载 status:', dl.status, ' 返回长度:', dl.body.length);
    }
  } catch (e) { console.log('playurl 失败', p.status, p.body.slice(0, 150)); }
})().catch((e) => console.log('异常', e.stack || e.message));
