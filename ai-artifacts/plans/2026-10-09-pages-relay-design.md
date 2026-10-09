# 免费 Pages 中转入口

用户在大陆服务器退出 Clash、关闭系统代理和 TUN 后，原测试页面五次请求成功（174–396ms），随后授权“开干”接入并测试；没有授权正式客户端发布。

采用 Pages 固定白名单转发 + 原 Worker 内部 Service Binding。保留原 Worker 的 D1、Secret、配对、群管理员权限校验与 webhook；不复制数据库，不创建新机器人，不需要重新配对。相比公开 URL 转发，内部绑定减少中间链路对公开域名的依赖。依据：https://developers.cloudflare.com/pages/functions/bindings/ 。

Pages 仅允许现有配对、状态、消息和命令消费接口；拒绝 webhook、任意路径和任意转发目标。只传 Authorization、Content-Type 和 POST body；不传 Cookie、查询参数，不跟随重定向，不自动重发。健康检测不带设备令牌，`/relay/health` 验证实际上游 ready；`/health` 保留原独立测试。

客户端优先选择健康的新入口直连，其次原入口直连，均不通时选择健康系统线路。首次请求前仅探测；后续失败检测限频一分钟，仅影响下一请求，不立即重发 POST 或消费式 GET。沿用本机通知队列重试边界，不能消除 Telegram 已接收但回执丢失的重复可能。

验证：单元测试覆盖固定目标、凭据保留、Cookie 丢弃、拒绝 webhook/重定向、服务绑定、故障不自动重发、备用入口选择；运行完整 Node 和五项 Electron 流程；线上健康、无授权消息拒绝和 webhook 拒绝。用户服务器完整链路与真实实收仍需验证；本机测试不代表长期大陆直连保证。正式发布还需用户确认、Windows 构建及安装包验证。
