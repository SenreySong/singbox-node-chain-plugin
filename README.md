# singbox-node-chain-plugin

GUI.for.Cores / GUI.for.SingBox 插件：为指定 sing-box 出站节点配置中转节点。

## 功能

- 为单个出站节点设置中转节点。
- 启动核心前写入 sing-box `detour` 字段。
- 插件配置独立保存，不修改订阅和 GUI 配置。
- 订阅或配置更新后，中转关系仍保留。
- 如果中转节点不存在，会自动清空对应中转并写回插件配置。
- 禁止循环链路，例如 `A -> B -> A`、`A -> B -> C -> A`。
- 保存当前运行配置时自动重启核心，让中转配置立即生效。
- 插件面板展示当前插件版本，节点展示和中转选择使用卡片式界面。
- 节点按常见国家和地区顺序排序，无法识别地区的节点排在最后。
- 中转节点选择支持按节点、类型和地区搜索。

## 文件

- `plugin-single-node-relay.js`：插件源码。
- `plugin-single-node-relay.metadata.json`：GUI.for.Cores 插件元数据模板。

## 安装

1. 将 `plugin-single-node-relay.js` 放到 GUI.for.Cores 的 `data/plugins/` 目录。
2. 添加插件时参考 `plugin-single-node-relay.metadata.json`。
3. 启用插件触发器：
   - `on::manual`
   - `on::ready`
   - `on::before::core::start`

也可以在 GFS 中使用聚合订阅源一次添加当前维护的插件：

```text
https://raw.githubusercontent.com/SenreySong/singbox-node-chain-plugin/main/plugin-subscription.json
```

当前聚合订阅包含：

- 指定节点中转
- 出站 DNS 解析器
- 策略组自动整理
- 测试版核心配置迁移
- TCP 延迟与测速

## 测试版核心配置迁移

`plugin-singbox-beta-migrator.js` 会在启动核心前处理最终生成配置，用于适配 sing-box 测试版核心的新配置要求。
它只修改传给核心启动的最终配置，不直接改订阅文件或原始 profile。
如果 GFS 没有暴露 sing-box 核心版本，可以在插件面板手动填写核心版本，例如 `1.14.0-alpha.33`。

强制类转换：

- 旧 DNS 服务器格式转换为 1.14 新格式，包含 `address_resolver` / `address_strategy`、`fakeip` 范围、`dhcp://`、`h3://`、server 级 `strategy` / `client_subnet` 迁移。
- `dns.rules[].outbound` DNS 规则迁移为出站 `domain_resolver`。
- TUN 入站的 `inet4/inet6_route_address` 与排除地址字段合并为 `route_address` / `route_exclude_address`。
- `rcode://` DNS 服务器会在预览中提示，需要按具体域名规则手动迁移为 `predefined` action。

推荐类转换：

- 删除 `dns.independent_cache`。
- `experimental.cache_file.store_rdrc` 改为 `store_dns`。
- direct 出站 `override_address` / `override_port` 改为 `route-options` 规则。
- 出站 `domain_strategy` 迁移到 `domain_resolver.strategy`。
- 旧 `type=dns` 出站和对应路由规则迁移为 `hijack-dns`。
- DNS 地址筛选规则迁移为 `evaluate + match_response`。
- 修正 `ip_version` / `query_type` 与旧 DNS 规则字段混用导致的 1.14 启动失败。
- 远程规则集 `download_detour` 迁移为 `http_client.detour`。
- 内联 `tls.acme` 迁移为 `tls.certificate_provider`。
- 清理 Tailscale 中已移除的 `control_http_client`。
- 检测 Hysteria v1 旧 QUIC 调优字段，并在面板中提示。
- 旧入站字段只提示，不默认自动改复杂语义。

功能注入：

- 默认域名解析器注入：当存在域名类出站且缺少 `domain_resolver` / `route.default_domain_resolver` 时，从 `dns.final` 或唯一 DNS 服务器 tag 注入 `route.default_domain_resolver`。
- TUN DNS 模式注入：当存在 TUN 入站时注入 `dns_mode: hijack`，并补充显式 `hijack-dns` 路由规则。
- 可在面板中填写 TUN DNS 地址，写入 `dns_address`；留空时使用 sing-box 自动派生地址。
- 可选注入 `dns.optimistic` 和 `dns.timeout`，默认关闭，避免改变现有 DNS 缓存和超时策略。
- 功能注入项在插件面板里单独展示，并可独立开关。
- 核心运行中可在面板查看 `data/sing-box/config.json` 的完整运行时配置，用于确认插件转换后的实际效果。

## TCP 延迟与测速

手动打开插件后可选择一个或多个节点，也可选择一个或多个策略组。策略组会展开为组内节点并去重。

- TCP 延迟测试默认使用 `https://cp.cloudflare.com/generate_204`。
- 下载测速默认使用 `https://speed.cloudflare.com/__down?bytes=25000000`，可自定义测速地址和下载字节数。
- 测试时会启动独立临时 sing-box 核心，每个节点绑定独立本地 HTTP 入站端口，避免并发测速互相串线。
- 默认启用旁路当前 TUN：自动检测系统默认物理接口，并给临时核心 DNS 和被测出站写入 `bind_interface` / `route.default_interface`；也可手动指定接口名。
- 测试结果保存到插件历史中，便于多次对比。

## 配置持久化

插件配置保存到：

```text
data/third/single-node-relay/rules.json
data/third/tcp-speed-tester/settings.json
data/third/tcp-speed-tester/history.json
```

该文件只记录节点与中转节点的映射，不写入订阅文件，也不修改 GUI profile。核心启动前插件会根据当前生成配置把映射转换成 sing-box 出站的 `detour` 字段。

## 适用范围

插件只展示并处理适合设置 `detour` 的普通出站节点，排除：

- `selector`
- `urltest`
- `direct`
- `block`
- `dns`

## 校验

已做静态检查：

```bash
node --check plugin-single-node-relay.js
```
