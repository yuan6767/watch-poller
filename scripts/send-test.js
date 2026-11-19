// 一次性发送测试：验证 GitHub Actions 能不能主动推到手表
const { ImClient } = require('../lib/im');

(async () => {
  const cfg = JSON.parse(process.env.IM_CONFIG_JSON || '{}');
  if (!cfg.imDeviceId) { console.log('缺少 IM_CONFIG_JSON'); process.exit(1); }
  const c = new ImClient(cfg);
  c.on('error', (e) => console.log('IM 错误', e.message));
  console.log('连接中…');
  await c.connect();
  console.log('已上线，等待链路稳定');
  await new Promise((r) => setTimeout(r, 2500));
  const text = '【云端通道测试】我在。这条是从 GitHub 的服务器发出来的，不经过家里的电脑、也不经过云主机。看到就说明云端通道已经通了。';
  const r = await c.sendText(211719271, text);
  console.log('发送结果:', JSON.stringify(r));
  await new Promise((r) => setTimeout(r, 1500));
  try { c.sock && c.sock.destroy(); } catch (e) {}
  process.exit(r && r.ok ? 0 : 2);
})().catch((e) => { console.log('异常', e.stack || e.message); process.exit(4); });
