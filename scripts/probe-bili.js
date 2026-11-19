// 从 GitHub 机器上实测 B站 / 网易云 的接口可达性
const https = require('https');

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REF = 'https://www.bilibili.com/';

(async () => {
  const ck = (process.env.BILI_COOKIE || '').trim();
  console.log('cookie 长度:', ck.length);

  console.log('\n=== 0 出口 IP ===');
  const ip = await req('https://api.ipify.org?format=json', {});
  console.log(ip.status, ip.body.slice(0, 80));

  console.log('\n=== 1 B站搜索（无 cookie）===');
  const r1 = await req('https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent('晴天 周杰伦'), { 'User-Agent': UA, Referer: REF });
  console.log(r1.status, r1.body.slice(0, 220));

  console.log('\n=== 2 B站搜索（带 cookie）===');
  const r2 = await req('https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent('晴天 周杰伦'),
    { 'User-Agent': UA, Referer: REF, Cookie: ck });
  console.log(r2.status, r2.body.slice(0, 220));

  // 解析出第一条 bvid
  let bvid = '';
  try {
    const j = JSON.parse(r2.body);
    const list = (j.data && j.data.result) || [];
    if (list[0] && list[0].bvid) bvid = list[0].bvid;
    console.log('搜索命中条数:', list.length, ' 第一条 bvid:', bvid);
  } catch (e) { console.log('解析失败', e.message); }

  if (bvid) {
    console.log('\n=== 3 取视频信息（拿 cid）===');
    const v = await req('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { 'User-Agent': UA, Referer: REF, Cookie: ck });
    let cid = 0, title = '';
    try {
      const j = JSON.parse(v.body);
      if (j.data && j.data.pages && j.data.pages[0]) cid = j.data.pages[0].cid;
      title = (j.data && j.data.title) || '';
      console.log('code:', j.code, ' 标题:', title.slice(0, 40), ' cid:', cid);
    } catch (e) { console.log(v.status, v.body.slice(0, 150)); }

    if (cid) {
      console.log('\n=== 4 取播放地址（含音频流）===');
      const p = await req(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=1`,
        { 'User-Agent': UA, Referer: 'https://www.bilibili.com/video/' + bvid, Cookie: ck });
      try {
        const j = JSON.parse(p.body);
        const dash = j.data && j.data.dash;
        const audioArr = (dash && dash.audio) || [];
        console.log('code:', j.code, ' audio 流数量:', audioArr.length,
          ' 首个URL:', audioArr[0] ? audioArr[0].baseUrl.slice(0, 90) : '无');
      } catch (e) { console.log(p.status, p.body.slice(0, 200)); }
    }
  }

  console.log('\n=== 5 网易云搜索 ===');
  const m = await req('https://music.163.com/api/search/get?s=' + encodeURIComponent('晴天') + '&type=1&limit=3',
    { 'User-Agent': UA, Referer: 'https://music.163.com/' });
  console.log(m.status, m.body.slice(0, 220));
})().catch((e) => console.log('异常', e.stack || e.message));
