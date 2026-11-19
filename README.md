# watch-poller

手表 AI 的云端兜底通道：跑在 GitHub Actions 上，跟家里电脑开不开机没有任何关系。

## 它做什么

每 5 分钟一次：
1. 连小天才 IM 服务器（im3.okii.com:8002），用设备凭证完成握手、登录、上线
2. 用 `syncKey` 游标拉取上次之后的新消息
3. 只处理手表（imAccountId 211719271）的私聊文字
4. 调智谱 AI 生成回复，发回手表
5. 把新的 syncKey 写进 `state.json` 并提交回来，下次接着拉

## 它不做什么

- 不处理群聊
- 不处理图片、语音、位置（那些留在云主机上的完整桥接里）
- 不会和云主机抢答：只回「发出来超过 6 分钟」的消息，云主机在线时（`HOST_HB_URL` 心跳新鲜）整轮跳过

## 需要的 Secrets

| 名称 | 内容 |
|---|---|
| `IM_CONFIG_JSON` | 设备凭证 JSON（token / mobileId / imDeviceId / imAccountId / syncKey / bizDeviceId / bizMac / bizMachineId） |
| `ZHIPU_KEY` | 智谱开放平台的 API Key |
| `HOST_HB_URL` | 可选。云主机心跳文件的 raw 地址，用来判断云主机是否在线 |

## 两个 workflow

- `net-check.yml`：手动触发，只测 GitHub 机器到 IM / 智谱的连通性，不碰任何业务
- `poll.yml`：每 5 分钟自动跑轮询

## 已知限制

- GitHub 定时任务在高峰期会延迟，甚至跳过某一次；实际延迟通常 5~15 分钟
- 单次运行有 6 分钟超时保护
- 只在默认分支的 `schedule` 生效，改完要等下一轮或手动 `workflow_dispatch`
