# HTTP、TCP 路由与 Tunnel 发布

Flux Gate 管理 Cloudflare Tunnel 的原生 ingress。三种模式使用同一组目标主机和端口，支持 IPv4、IPv6 和主机名。

| 模式 | 配置 | 请求链路 |
| --- | --- | --- |
| HTTP 密码保护 | `type: "http"`, `no_password: false` | Cloudflare → cloudflared → Flux Gate Basic Auth → HTTP 目标 |
| HTTP 直连 | `type: "http"`, `no_password: true` | Cloudflare → cloudflared → HTTP 目标 |
| TCP 直连 | `type: "tcp"` | Cloudflare 客户端 → Cloudflare → cloudflared → TCP 目标 |

HTTP 密码保护可使用默认账号密码，也可为路由单独设置账号密码。直连 HTTP 由目标服务自身认证；TCP 使用 SSH key、数据库账号等目标协议认证。TCP 不接受 HTTP 账号密码字段。

自定义账号密码在新增或完整编辑保存时都必须重新填写两项，密码不回显，也不留空复用旧密码。仅启停路由的 PATCH 操作保留现有凭据。请求层的 `auth_mode` 区分 `default`、`custom` 与直连 HTTP 的 `none`，不单独持久化。

## 配置示例

```json
{
  "type": "tcp",
  "subdomain": "database",
  "ip": "2001:db8::10",
  "port": 5432,
  "description": "Database access",
  "disabled": false
}
```

`ip` 填目标 IP 或主机名，`port` 填 1～65535 的端口。IPv6 可以带方括号输入，保存时使用裸地址，接线 URL 自动添加方括号。省略 `type` 的已有路由按 HTTP 处理。

Flux Gate 只代理需要密码保护的 HTTP 路由，并支持 HTTP WebSocket 升级。直连 HTTP 与 TCP 的连接由 cloudflared 直接发起到目标；网关进程不承担这两类流量。FTP 等使用额外数据连接的协议需要分别安排数据连接，单条 TCP 路由不能覆盖完整 FTP 服务。

HTTP 直连 ingress 设置 `originRequest.httpHostHeader` 为目标的 `host:port`，保持与网关原有 `changeOrigin` 相同的目标 Host。密码保护 ingress 保留公网 Host，使网关能识别子域名。跨层的 HTTPS、可信代理、Origin 与 Cookie 设置仍由目标服务正确配置。

<a id="tunnel-integration"></a>
## Tunnel 集成

在受信任的网关 `config.json` 中启用集成：

```json
{
  "tunnel": {
    "enabled": true,
    "config_file": "/absolute/path/to/cloudflared/config.yml",
    "process_name": "cloudflare-tunnel"
  }
}
```

省略 `config_file` 时使用运行用户的 `~/.cloudflared/config.yml`，省略 `process_name` 时使用 PM2 的 `cloudflare-tunnel`。进程需要读取和写入 Tunnel 配置，并能运行 `cloudflared` 与 `pm2`。网页请求不能指定文件路径或命令。

Tunnel 配置必须使用 block-list ingress。先部署管理域名、通配 HTTP 入口和最终回退；网关会在它们之前插入受管规则：

```yaml
tunnel: your-tunnel-id
credentials-file: /absolute/path/to/tunnel-credentials.json
ingress:
  - hostname: example.com
    service: http://127.0.0.1:8080
  - hostname: "*.example.com"
    service: http://127.0.0.1:8080
  - service: http_status:404
```

域名和通配 DNS 必须指向该 Tunnel。配置中的受管片段位于 `# BEGIN FLUX GATE ROUTES` 与 `# END FLUX GATE ROUTES` 之间。管理域名、通配规则、独立 SSH 恢复入口和其他区块外内容会保留。显式 hostname 与区块外规则冲突时停止发布。

停用路由会生成该 hostname 的 `http_status:404` 规则；删除或改名后的受管 hostname 也保留为 404，避免被通配规则重新开放。需要重新使用域名时创建同名路由即可替换阻断规则。

## 保存与应用

保存路由只更新网关配置。所有模式都需要点击“应用到 Tunnel”，才能更新公网接线。目标、类型、启停、删除和密码保护分支修改均应核对应用状态。

尤其是 HTTP 直连切换为密码保护：保存后旧的公网直连仍可访问，直到应用成功。界面分别展示当前接线和待应用接线，不能将已保存视为已受保护。直连停用或删除也要应用后才阻断公网。HTTP 已经过网关时，账号密码与网关内的目标变更可立即影响请求。

后台使用进程内锁和排他文件锁，生成候选配置并调用 `cloudflared tunnel ingress validate`。原配置备份到运行用户的 `~/backups/flux-gate/tunnel/`；确认文件和路由未并发变化后，原子替换配置并重启指定 Tunnel。重启失败会还原原文件并再次重启；恢复重启失败会明确要求使用主机恢复入口。配置和备份使用 600 权限。

“已应用”表示受管规则与已保存路由一致，且配置全文哈希对应成功的重启记录。它不等于 DNS、Cloudflare Access、目标登录或业务流程已通过验收。无法确认当前配置对应成功重启时，当前链路显示未知。已应用且内容无变化时，重复应用不会重启 Tunnel。共享 Tunnel 重启可能短暂中断现有连接。

API `GET /api/tunnel` 返回期望 `rules`、已确认 `current_rules`、`current_verified` 和逐域名 `changes`。`changes` 包含 `desired_service`、`current_service`、`desired_path`、`current_path` 和 `status`。`GET /api/routes` 为数组，各路由提供 `target_service`、`tunnel_service`、相同的当前/期望路径、`current_verified` 与 `publication_status`；不会返回密码哈希。

管理页还会只读显示配置文件中的全部 ingress，包括管理域名、通配、独立 SSH、路径规则和最终回退。`existing_rules` 仅返回 `hostname`、`path`、`service` 与受管标识 `managed`；区块外入口没有编辑或接管操作。此视图表示文件已读取，运行状态仍取决于 `current_verified`，不能将读到文件视为服务已生效。集成停用或候选规则冲突时仍可读取现有配置；读取失败通过 `existing_rules_error` 显示，不回显 YAML 原文、凭据或请求头。

也可在主机执行同一发布逻辑：

```sh
node deploy/cloudflare-tunnel/apply-routes.cjs --config /absolute/path/to/flux-gate/config.json
```

如果遗留 `.flux-gate.lock`，先确认没有发布在运行并检查配置和 PM2 状态，再移除锁。恢复时先停止配置写入，将备份恢复到原 Tunnel 路径，执行原生校验后重启相同 Tunnel 进程。升级过程中若同时切换网关和 Tunnel，应先恢复网关应用，再恢复与该版本匹配的 Tunnel 接线，避免旧的无密码路由被新网关拒绝。

## TCP 客户端

TCP 子域名用于选择 Cloudflare Tunnel 入口，不能用普通客户端直接连接该域名的任意公网 TCP 端口。使用官方 `cloudflared`：

```sh
cloudflared access tcp --hostname database.example.com --url 127.0.0.1:15433
```

然后让数据库客户端连接 `127.0.0.1:15433`。这个端口是客户端转接端口。SSH 可以使用 `cloudflared access ssh` 作为 SSH 的 ProxyCommand，服务器仍按 SSH key 鉴权。Cloudflare 承担客户端隧道传输，Flux Gate 不自建隧道协议。

建议在受管区块外维护独立的主机恢复入口，直连 SSH 等服务，预先验证其密钥登录。恢复入口不依赖 Flux Gate 应用运行。

## TLS、认证与目标协议

公网 `https://demo.example.com` 可以连接内部 `http://192.168.1.10:3000`。浏览器 TLS 在 Cloudflare 边缘终止，公网证书由 Cloudflare 管理和续期；Cloudflare 与 cloudflared 通过加密 Tunnel 通信。

HTTP 目标当前固定使用 `http://`，不支持 HTTPS origin。内部 HTTP 段不会自动变成 TLS，也不要求目标配置本机证书。跨局域网使用 HTTP 仍是明文，应按内部网络的信任边界配置。

Flux Gate Basic Auth 提供 HTTP 密码保护，不提供目标协议的端到端加密。TCP 不解释协议内的 TLS 或证书；SSH、数据库等服务的认证和端到端加密由相应服务与客户端负责。

## 升级迁移

由 TCP 监听版本升级时，发布逻辑可将一个已存在的 `FLUX GATE TCP` 区块替换为 `FLUX GATE ROUTES`，不会同时保留两份受管规则。两种标记同时存在会停止发布，要求先检查配置。旧配置中的 TCP 监听字段不参与新接线；该路由下次保存时会替换为当前目标结构。先发布新的 Tunnel 接线并验收直连，再切换网关应用，可避免原有 HTTP 无密码路由在升级间隙中断。

## 官方资料

- [Cloudflare Tunnel 支持的协议](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)
- [客户端 cloudflared 连接 SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/)
