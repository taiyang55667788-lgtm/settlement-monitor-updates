# 免费入口连接测试

Pages 入口转发固定白名单接口到原配对 Worker；没有 Secret 或数据库绑定，不复制 Bot Token，设备令牌按原授权方式传给固定上游。拒绝 webhook 和其他接口，不转发 Cookie、查询参数或任意目标，不跟随重定向，不自动重试。现有配对与 webhook 留在原服务。

部署命令（项目根目录）：

```sh
cd relay-connectivity-test
wrangler pages deploy public --project-name settlement-connectivity-test --branch main
```

根页面可手动连续执行五次 `/relay/health` 请求，验证 Pages 到原 Worker 的完整链路，每次最长 10 秒，不带凭据、不缓存、不发送消息。`/health` 保留原入口自身的测试。成功不是大陆长期可达的保证。客户端源码默认选择此入口、保留原入口备用；尚待发布及用户服务器实际消息实收验证。

必须从本目录部署以读取 wrangler.jsonc 的 PAIRING 服务绑定，使用内部连接而非依赖原 Worker 公开域名。入口不购买域名或升级收费套餐；仍受账号现有免费额度限制。
