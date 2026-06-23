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

## 测试版核心配置迁移

`plugin-singbox-beta-migrator.js` 会在启动核心前处理最终生成配置，用于适配 sing-box 测试版核心的新配置要求。
它只修改传给核心启动的最终配置，不直接改订阅文件或原始 profile。

强制类转换：

- 旧 DNS 服务器格式转换为 1.14 新格式。
- `dns.rules[].outbound` DNS 规则迁移为出站 `domain_resolver`。
- TUN 入站的 `inet4/inet6_route_address` 与排除地址字段合并为 `route_address` / `route_exclude_address`。

推荐类转换：

- 删除 `dns.independent_cache`。
- `experimental.cache_file.store_rdrc` 改为 `store_dns`。
- direct 出站 `override_address` / `override_port` 改为 `route-options` 规则。
- 复杂 outbound DNS 规则、DNS 响应匹配和旧入站字段只提示，不默认自动改复杂语义。

## 配置持久化

插件配置保存到：

```text
data/third/single-node-relay/rules.json
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
