# 交收监控

跨平台桌面应用，可同时登录多个本级账号，监控各账号下级代理的“本周报表 → 上级交收 → 交收金额”，达到每个下级代理各自设置的阈值时发送 Telegram 通知。

## 功能

- 多个本级账号并行监控，各自使用独立浏览器会话
- 安全码、账号、密码自动填写
- 分段式盘口登录配置界面，安全码输入内容直接显示
- 数字验证码本地 OCR，失败时自动刷新重试
- 自动选择延迟最低的代理线路
- 兼容导航站随机域名跳转，不会把正常跳转误判为登录失败
- 显示代理线路测速结果、当前登录阶段和明确的失败位置
- 自动检测掉线并重新登录
- 只监控本级账号下的代理，不对本级合计金额发提醒
- 自动列出下级代理数量，每个下级代理单独设置 `≥` 和 `≤` 双向阈值
- Telegram 越线提醒去重；数值恢复后重新待命
- 敏感配置通过操作系统加密服务保存
- 启动时和每 6 小时自动检查版本，后台下载并提示重启安装

## 开发运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm start
```

## 打包

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

Windows 安装包需要在 Windows 电脑上执行 `npm run build:win`；macOS 安装包需要在 Mac 上构建。生成文件位于 `dist`。

## 自动更新发布

Windows 版本默认从 [GitHub Releases](https://github.com/taiyang55667788-lgtm/settlement-monitor-updates/releases/latest) 检查更新。推送 `v*` 标签后，GitHub Actions 会自动构建安装包、便携版、`latest.yml` 和差分更新文件并发布。应用会自动比较版本号、下载更新，并在用户确认重启后安装。

发布新版本前先修改 `package.json` 的 `version`。正式分发 macOS 版本时需要使用 Apple Developer 证书签名；Windows 建议使用代码签名证书，避免系统安全警告。

## Telegram 准备

1. 在 Telegram 联系 `@BotFather` 创建机器人并取得 Bot Token。
2. 先给机器人发一条消息。
3. 把 Token 填入应用，点击“自动获取 Chat ID”，保存后发送测试消息。

## 说明

应用只读取报表，不会下注或修改后台数据。网站页面结构若发生变化，可能需要更新 `electron/monitor.js` 中的页面识别规则。
