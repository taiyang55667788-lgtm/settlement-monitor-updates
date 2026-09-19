# 交收监控维护上下文

更新时间：2026-09-19  
当前正式版本：`v1.0.14`  
`v1.0.14` 功能基线提交：`2a41672`

## 项目定位

这是一个 Electron 桌面应用，可在 Windows 等电脑上同时独立登录多个本级账号，读取各账号往下两级代理的本周报表，并按每个代理独立设置的金额间隔发送 Telegram 提醒。

- 本机项目目录：`/Users/ty/Documents/Codex/2026-09-09/new-chat/outputs/report-monitor-app`
- GitHub 仓库：`https://github.com/taiyang55667788-lgtm/settlement-monitor-updates`
- 自动更新源：`https://pub-649c460a80df4ab1a6c668e4e67e2b6d.r2.dev`
- Telegram 配对服务：`https://settlement-monitor-pairing.taiyang55667788.workers.dev`
- Telegram 机器人：`@runmingbot`

本地项目和 Git 仓库是后续维护的代码依据。本文不记录盘口账号、密码、安全码、Bot Token、Cloudflare 密钥或设备配对令牌。

## 已完成的核心功能

### 登录与线路

- 输入导航网址及明文安全码，自动识别可用代理线路并优先选择最快线路。
- 多个本级账号使用独立的 Electron 持久会话，可同时监控。
- 自动填写盘口账号和密码，本地 OCR 尝试识别验证码。
- 自动验证码连续失败时，可以通过“盘内查看”手动登录。
- 安全码在添加和编辑界面均明文显示；密码不回显。
- 自动检测掉线并重新登录。

### 报表读取

- 只读取“本星期”日期范围，查询后再次核对报表顶部的周区间。
- 监控直属代理及每个直属代理往下一级的代理，共两级。
- 当前唯一业务指标是本周报表的“应收下线”，不是“上级交收”。
- 程序必须在表头中找到唯一的“应收下线”列；缺失、重复或数据错位时停止提醒，不猜测其他金额列。
- 已用真实盘口结构核对：第一层表头中“会员输赢”跨 3 列、“代理输赢”跨 9 列；第二层表头含“应收下线”。普通数据行目标金额位于第 10 个单元格，合计行因首格跨 2 列而少一个 DOM 单元格。
- 软件只显示提取后的层级表格，不内嵌盘口原报表。

### 提醒规则

- 每个代理可独立设置备注和提醒间隔，备注同步到 Telegram。
- 提醒以 0 为基准，正负方向分别计算。例如间隔 100 时，`+100/+200/+300` 和 `-100/-200/-300` 分别为独立档位。
- 同一代理、同一间隔、同一报表周、同一正负档位只成功提醒一次；金额回落后再次到达旧档位不会重复提醒。
- 一次跨越 20 档以内会逐档发送；超过 20 档会合并成一条消息，并把跨过的档位全部记为已通知。
- 更换报表周后重新开始记录。不同代理路径和不同提醒间隔的记录互不干扰。
- `v1.0.14` 从旧“上级交收”口径切换到“应收下线”。旧提醒记录会归档，不能阻止新口径提醒；旧账号第一次成功读取新口径时，每个已越档代理只发送一条首次汇总，之后恢复逐档提醒。
- Telegram 普通消息不能改变文字颜色，因此正数用 `🔵`，负数用 `🔴`；应用内正数显示蓝色、负数显示红色。

### 可解释状态

每个代理行显示：

- 本周应收下线；
- 本周正向和负向已提醒范围；
- 最后成功读取时间；
- 当前未提醒原因，如未设置间隔、尚未达到首档、当前档已通知、通知失败或数据已过期。

读取失败时会保留该代理上一次成功数据并明确标记“数据已过期”，过期数据不会触发 Telegram 提醒。检查尝试时间与成功读取时间不得混用。

### 界面与更新

- 支持深蓝、石墨黑、浅色和高对比四种主题，选择会保存到本机。
- Windows 应用启动时及每 6 小时检查 Cloudflare R2 更新源。
- 更新在后台下载，准备完成后可重启安装；安装版会覆盖旧版本，保留本机加密设置。
- Telegram 支持一次性配对码；Bot Token 只保存在 Cloudflare Worker Secret 中，不进入安装包。

## 主要代码入口

- `electron/monitor.js`：登录、报表查询、两级代理下钻、监控循环和 Telegram 文本。
- `electron/report-parser.js`：表头展开、应收下线列识别、金额解析和档位计算。
- `electron/alert-ledger.js`：每周正负档位去重、首次汇总和提醒记录。
- `electron/store.js`：系统加密存储、公开状态、代理快照及主题设置。
- `electron/main.js` / `electron/preload.js`：Electron IPC 和界面可调用能力。
- `ui/app.js` / `ui/styles.css` / `ui/index.html`：监控表格、已提醒档位、正负颜色和主题。
- `pairing-service/`：Cloudflare Worker 与 D1 Telegram 配对服务。
- `.github/workflows/release.yml`：Windows 验证、构建、R2 上传和 GitHub Release。

## 发布与验证流程

开发环境没有全局 Node 时，使用 Codex 随附的 Node 和 pnpm；常规环境直接执行：

```bash
pnpm test
pnpm test:desktop
```

当前测试覆盖：

- 真实形状的双层合并表头与“应收下线”列定位；
- 本周日期核对和两级代理下钻；
- 正负档位去重、服务重启、换周、发送失败重试和首次汇总；
- 二级代理读取失败时保留旧数据但不提醒；
- 已提醒档位、最后成功读取时间、安全码明文和四种主题；
- Telegram 配对及手动模式；
- 更新清单与 Windows 文件名。

`v1.0.14` 发布前的结果：57 项 Node 测试通过，Electron 桌面流程测试通过，Windows 安装包构建、更新清单校验、R2 上传和 GitHub Release 均通过。安装包 SHA-512 与 `latest.yml` 一致。

发布步骤：

1. 修改 `package.json` 版本号。
2. 运行 `pnpm test` 和 `pnpm test:desktop`。
3. 提交并推送 `main`。
4. 先用 `workflow_dispatch` 生成验证安装包，不上传更新。
5. 验证构建通过后创建并推送 `v*` 标签。
6. 标签工作流再次测试并构建，然后上传 Cloudflare R2 和 GitHub Release。
7. 最后直接读取 R2 的 `latest.yml`，核对版本、安装包 URL、大小和 SHA-512。

## 当前发布信息

- 版本：`v1.0.14`
- Windows 安装包：`https://pub-649c460a80df4ab1a6c668e4e67e2b6d.r2.dev/Settlement-Monitor-Setup-1.0.14-x64.exe`
- 安装包大小：117,431,443 字节
- SHA-512：`+swcrwQXkjnFb9JAoPH1wo6vdNTE/7138jBaON2CuUi2sMxdpcCCmVDgg4ZYt0pD2+72gSXqiuLJhxHChBt/Fw==`
- GitHub Release：`https://github.com/taiyang55667788-lgtm/settlement-monitor-updates/releases/tag/v1.0.14`

## 后续维护重点

1. 网站表头或登录页结构变化时，先用真实盘口只读核对，再更新测试样本；不要靠固定末列或猜测金额位置。
2. 新版本发布前必须同时通过单元测试、Electron 桌面流程测试和 Windows 构建验证。
3. 不把真实凭据、Token、设备令牌或 Cloudflare Secret 写入源码、测试、截图或文档。
4. 如果用户报告“为什么没提醒”，先看该代理的本周已提醒档位、最后成功读取时间、过期标记和运行记录，再判断是未越新档、已提醒、读取失败还是 Telegram 失败。
5. 远程 Windows 实机仍应在每次重大更新后做一次：自动登录、直属代理读取、二级代理读取、Telegram 实收和自动更新覆盖安装检查。

## 下次继续时的简短说明

可以直接说：

> 继续维护交收监控项目。先阅读 `MAINTENANCE_CONTEXT.md` 和 `README.md`，检查 Git 状态及当前正式版本，再处理新的需求；修改后必须跑 Node 测试、Electron 桌面流程测试和 Windows 验证构建，验证完成前不要发布更新。
