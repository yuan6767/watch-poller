# watch-poller

手表 AI 的**云端兜底通道**。跑在 GitHub Actions 上，不依赖家里的电脑、也不依赖云电脑容器。

## 它是干什么的

云电脑容器会频繁重启，重启期间原来的桥接（`aibridge.js`）掉线，手表 AI 就没人应答。
这个仓库用 GitHub 的免费服务器当「第二张嘴」：

```
每 5 分钟（GitHub cron）
      ↓
连小天才 IM（im3.okii.com:8002）→ 拉未读 → 判断云主机在不在 → 不在就回 → 断开
```

## 双通道怎么不打架

| 通道 | 谁在跑 | 什么时候回 |
|---|---|---|
| 主通道 | 云主机 `aibridge.js` | 一直在线，秒回 |
| 兜底通道 | 本仓库 `poller.js` | 云主机心跳过期（>12 分钟）才回 |

云主机每 5 分钟用 `hb_push.sh` 把 `heartbeat.json` 推到本仓库；`poller.js` 读它判断主通道是否还活着。
**主通道活着 → 只消费不回复；主通道死了 → 接管回复。**

另外还有两道保险：
- `REPLY_WINDOW_MIN=6`：只回 6 分钟以前的消息，避免和主通道抢答
- `MAX_AGE_MIN=45`：超过 45 分钟的旧消息只消费不回复，防止把积压消息一次性刷屏

## 文件

| 文件 | 作用 |
|---|---|
| `poller.js` | 主逻辑：连 IM、拉未读、调 AI、回复 |
| `lib/im.js` | 小天才 IM 协议（TLS 长连接 + 自研二进制帧 + RSA 握手） |
| `scripts/net-check.js` | 连通性自检：出口 IP、IM TCP、AI TCP、AI 真调 |
| `scripts/send-test.js` | 主动发一条消息到手表，验证发送链路 |
| `state.json` | 每轮回写同步进度（由 workflow 自动 commit） |
| `heartbeat.json` | 云主机写入的心跳，本仓库只读 |

## Secrets

| 名字 | 内容 |
|---|---|
| `IM_CONFIG_JSON` | 手表 IM 设备凭证（imDeviceId / imAccountId / token 等） |
| `CLOUDFLARE_CONFIG_JSON` | Cloudflare Workers AI（主力，美国节点对 GitHub 友好） |
| `ZHIPU_KEY` | 智谱 key（兜底；国外 IP 直连易超时，仅作备选） |
| `HOST_HB_URL` | 心跳文件地址：`https://api.github.com/repos/yuan6767/watch-poller/contents/heartbeat.json` |

## 实测结论（2026-11-19）

- GitHub runner 出口 IP：`13.71.226.179`（美国 AWS）
- `im3.okii.com:8002` TCP：**通，298ms**
- IM 登录 + sync：**成功**，syncKey 513 → 4770
- 主动发消息：**成功**，`{"ok":true,"code":200}`
- 智谱 API 从美国 IP：**HTTP 超时** → 已改用 Cloudflare 主力
- GitHub API 必须带 `User-Agent`，否则 403

## 已知限制

1. **不是实时**：GitHub cron 最快 5 分钟一次，高峰期会延迟甚至跳过，真实延迟 5~15 分钟。
2. **只能文字**：B 站点播、识图、点歌这些复杂功能只有云主机的 `aibridge.js` 能做。
3. **首次发送可能超时**：美国 IP 偶发风控，链路稳定后正常。
4. **两个通道共用同一套设备身份**：谁先连上谁拿消息，这也是天然的防重复机制。
