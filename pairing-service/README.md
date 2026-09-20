# Telegram 配对服务

这个 Cloudflare Worker 只负责把一次性配对码关联到 Telegram 私聊，再转发提醒文字。盘口账号、密码和安全码不发送到 Worker。桌面端只保存随机设备凭据，Bot Token 只放在 Cloudflare Secret 中。一个机器人限定一个 Telegram 私聊：首次成功配对的私聊成为所有电脑的通知接收者。

## 首次部署

需要能管理 Cloudflare Workers 和 D1 的账号，以及一个已在 BotFather 创建的 Telegram 机器人。不要把 Bot Token 写入源码、配置文件、聊天或安装包。

1. `wrangler.jsonc` 已配置机器人 `@runmingbot` 和专用 D1 数据库。部署到别的 Cloudflare 账号时，需替换数据库 ID。
2. 执行 `schema.sql` 初始化远程 D1。
3. 把机器人 Token 存为 Worker Secret `BOT_TOKEN`；另外生成一个随机、不含空格的 Secret，存为 `WEBHOOK_SECRET`。部署 Worker。
4. 用浏览器访问 Worker 的 `/health`，确认 `ready: true`。将 Worker 的 HTTPS 根地址写入 `electron/pairing-config.js`，再制作新安装包。
5. 在自己的电脑安装新版本，点击“生成配对码”“打开机器人”，发送代码。Worker 在生成配对码时自动调用 Telegram 官方 API 设置 webhook；若 Bot Token 错误，就不会生成配对码。首次配对的 Telegram 私聊成为该机器人唯一的接收者。再点击“发送测试消息”确认收到。

不要把 Token 放在 shell 命令历史里。部署前至少验证：错误 webhook Secret 被拒绝；第二个 Telegram 私聊不能绑定；正确私聊能收到测试消息；解除绑定后不能发送消息。未完成以上端到端验证，不发布带有配对按钮的新版本。

`wrangler.jsonc` 只含非密钥配置，可随项目保存；Bot Token 和 webhook Secret 必须只存在于 Cloudflare Worker Secrets。更换接收者需要在 D1 中重置 `bot_owner`，这是管理员操作，不能通过客户端解除绑定来改变接收者。
## Telegram 指令

仅机器人唯一拥有者的私聊可发送 `/report`、`/报表`、`/status` 或 `/状态`。Worker 会把请求排队给已配对的在线电脑；电脑完成刷新后，用同一机器人返回当下可读取的两级代理数据。离线电脑不会立即回应。
