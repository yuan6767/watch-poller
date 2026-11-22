// 云端炸了时的备用播报：完全跑在 GitHub 上，用独立账号（175252276）发一条纯文字到手表
// 用途：本机 token 挂了 / 云主机失联时，这条通道不依赖本机任何东西
const https = require('https');
const { ImClient } = require('../lib/im');

(async () => {
  const msg = (process.env.MSG || '').trim() || '⚠️ 云端炸了（没拿到原因）';
  let cfg;
  try { cfg = JSON.parse(process.env.IM_CONFIG_JSON || '{}'); } catch (e) { console.log('IM_CONFIG_JSON 解析失败'); process.exit(1); }
  if (!cfg.token) { console.log('缺少 IM_CONFIG_JSON'); process.exit(1); }
  const c = new ImClient(cfg);
  c.on('error', (e) => console.log('IM 错误', e.message));
  try {
    await c.connect();
    await new Promise((r) => setTimeout(r, 1800));
    const r = await c.sendText(211719271, msg);
    console.log('发送结果', JSON.stringify(r));
    await new Promise((r) => setTimeout(r, 1000));
    try { c.sock && c.sock.destroy(); } catch (e) {}
    process.exit(r && r.ok ? 0 : 2);
  } catch (e) {
    console.log('发送失败', e.message);
    process.exit(3);
  }
})();
