# Telegram 配对服务

这个 Cloudflare Worker 将一次性配对码关联到一台电脑，再由 Worker 转发提醒文字到 Telegram。盘口账号、密码和安全码不发送到 Worker；桌面端只保存随机设备凭据，Bot Token 只存在 Cloudflare Worker Secret。

同一个官方机器人可供多人使用：每台电脑生成的配对码只可使用一次，任意用户可以在自己的 Telegram 私聊中发送该码，通知只会发往该用户的私聊，不会与其他用户混在一起。

也可通知到群：将机器人加入目标群并设为群管理员，再由群管理员发送 `/pair 配对码`。群内的 `/report`、`/status`、`/top`、`/alerts` 与 `/check` 也只接受群管理员发送，且只会作用于绑定到该群的电脑。

## 首次部署

需要能管理 Cloudflare Workers 和 D1 的账号，以及一个已在 BotFather 创建的 Telegram 机器人。不要把 Bot Token 写入源码、配置文件、聊天或安装包。

1. `wrangler.jsonc` 已配置机器人 `@runmingbot` 和专用 D1 数据库。部署到别的 Cloudflare 账号时，需替换数据库 ID。
2. 执行 `schema.sql` 初始化远程 D1。
3. 把机器人 Token 存为 Worker Secret `BOT_TOKEN`；另外生成一个随机、不含空格的 Secret，存为 `WEBHOOK_SECRET`。部署 Worker。
4. 用浏览器访问 Worker 的 `/health`，确认 `ready: true`。将 Worker 的 HTTPS 根地址写入 `electron/pairing-config.js`，再制作新安装包。
5. 私聊验证：在电脑点击“生成配对码”→“打开机器人”→点开始或发送配对码，确认收到测试消息。
6. 群聊验证：把机器人设为群管理员，由群管理员发送 `/pair 配对码`，确认测试消息到达该群，并确认普通群成员的 `/report` 不会执行。

机器人在生成配对码时自动调用 Telegram 官方 API 设置 webhook；若 Bot Token 错误，就不会生成配对码。官方配对模式由 Worker 调用 Telegram，运行监控的电脑只需访问 Worker，不直接请求 Telegram API。

不要把 Token 放在 shell 命令历史里。部署前至少验证：错误 webhook Secret 被拒绝；不同私聊可分别绑定；普通群成员不能配对或执行指令；群管理员能配对并执行指令；解除绑定后不能发送消息。未完成以上端到端验证，不发布带有配对按钮的新版本。

`wrangler.jsonc` 只含非密钥配置，可随项目保存；Bot Token 和 webhook Secret 必须只存在于 Cloudflare Worker Secrets。旧版数据库可能保留未使用的 `bot_owner` 表，不影响多人配对；不应为此删除现有数据。
## Telegram 指令

私聊中的指令只作用于绑定到该私聊的在线电脑；群聊中的指令只作用于绑定到该群的在线电脑，且仅群管理员可执行。电脑完成刷新后，用同一机器人返回当下可读取的最多五级代理数据；离线电脑不会立即回应。

- `/report` 或 `/status`：刷新并返回当前报表。
- `/top`：返回当前金额绝对值前 10 名。
- `/alerts`：返回最近 10 条提醒。
- `/check`：刷新全部启用账号。
- `/check 账号名`：刷新指定账号。
- `/help`：查看指令说明。
