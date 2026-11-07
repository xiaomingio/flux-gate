# TCP 转发与 Cloudflare Tunnel

Flux Gate 直接使用 Node.js TCP socket 转发字节流。HTTP 路由继续按子域名代理 Web 服务；TCP 路由使用独立的本机监听端口。管理界面提供 HTTP/TCP 类型、TCP 监听端口、目标地址、启停和删除。

## 路由配置

```json
{
  "type": "tcp",
  "subdomain": "database",
  "listen_port": 15432,
  "ip": "192.168.1.10",
  "port": 5432,
  "description": "Database access",
  "disabled": false
}
```

`listen_port` 是 Flux Gate 本机的监听端口，只绑定 `127.0.0.1`，范围为 1024～65535，不能与管理端口或其他 TCP 路由重复。`ip` / `port` 是目标主机与端口。已有未填写 `type` 的路由按 HTTP 处理。

保存启用的 TCP 路由时，后台先实际绑定端口，再原子保存配置。端口被占用、无权限或保存失败时，原有配置与监听继续有效。启停、修改目标、改名及删除会关闭该路由已有连接，后续连接使用新配置；启动时会重新建立已保存监听，绑定失败则停止启动并显示错误。

每条路由最多 32 个连接，全部 TCP 路由合计最多 128 个。目标连接建立超时为 10 秒；转发使用标准流的背压和半关闭，不缓存整份传输，也不主动重试中断的业务请求。目标在界面中显示为固定的 `tcp://`，端口由用户自行填写。FTP 等使用额外数据连接的协议需要另行安排这些连接，单条 TCP 路由不能覆盖完整 FTP 服务。TCP 不使用 HTTP Basic Auth，认证与加密由目标协议负责，例如 SSH 公钥或数据库自身 TLS/账号。

## 公网接入

Cloudflare Tunnel 的 HTTP wildcard 规则不能把 TCP 自动交给网关。每个启用的 TCP 路由需要一条独立 ingress，例如：

```yaml
ingress:
  - hostname: database.example.com
    service: tcp://127.0.0.1:15432
  - hostname: "*.example.com"
    service: http://127.0.0.1:8080
  - service: http_status:404
```

DNS 域名本身不限定 HTTP 或 TCP；这里的子域名用于让 cloudflared 选择 Tunnel 入口，不是网页 URL。HTTP 请求携带 Host，能够共用网关 HTTP 端口；普通 TCP 连接不携带 DNS 名，因此每条路由需要独立监听端口。TLS SNI 只适用于特定 TLS 流量，不能通用于 SSH 等协议；网关不额外实现协议识别或多路复用。域名还须通过 DNS 指向该 Tunnel。客户端使用官方 `cloudflared`：

```sh
cloudflared access tcp --hostname database.example.com --url 127.0.0.1:15433
```

随后让数据库客户端连接本机 `127.0.0.1:15433`。SSH 目标也可使用 `cloudflared access ssh` 作为 SSH 的 ProxyCommand，服务端仍按 SSH key 鉴权。公开的 Tunnel TCP 入口需要 Cloudflare 官方客户端，不能直接向域名的任意公网 TCP 端口连接普通客户端。客户端传输由 Cloudflare 实现，Flux Gate 不实现额外的 WebSocket 隧道协议。

生产中可以另行维护独立的恢复入口，直接连接到目标服务，放在下述受管区块之外。这类入口不依赖 Flux Gate 应用是否运行。

## 管理界面发布到 Tunnel

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

省略 `config_file` 时使用运行用户的 `~/.cloudflared/config.yml`，省略 `process_name` 时使用 PM2 的 `cloudflare-tunnel`。网关进程必须能运行 `cloudflared`、`pm2`，读写 Tunnel 配置并重启该进程。配置由部署者维护，网页请求不能传入命令或文件路径。

保存 TCP 路由只改变真实本机监听。管理页的 Tunnel 区域显示待应用状态；点击“应用到 Tunnel”并确认后，后台才发布公网接线。重启共享 Tunnel 时，现有 Tunnel 连接可能短暂中断。已应用且内容没有变化时，重复应用不会重启进程。

后台只管理 `# BEGIN FLUX GATE TCP` 与 `# END FLUX GATE TCP` 之间的片段。原有 HTTP、独立 SSH 等其他 ingress 与注释保留；若要发布的 hostname 已由区块外规则占用，会停止并要求先处理冲突。不要手工移动或修改受管标记。

发布流程使用进程内锁和排他文件锁：生成候选配置，运行 `cloudflared tunnel ingress validate`，将原配置备份到运行用户的 `~/backups/flux-gate/tunnel/`，核对源文件未并发变化，再原子替换并重启指定 Tunnel 进程。重启失败会还原原文件并再次重启；恢复重启也失败时明确返回需要人工恢复的错误。配置文件与备份以 600 权限保存。

“已应用”表示受管片段与当前路由一致，且配置全文哈希对应成功的重启记录。它不代表 DNS、Cloudflare Access 策略或目标服务登录已验收；应使用公网客户端完成真实连接。配置变动、启停或删除后需要再次应用，才能移除或修改旧公网入口。

也可在主机上执行同一发布逻辑：

```sh
node deploy/cloudflare-tunnel/apply-tcp.cjs --config /absolute/path/to/flux-gate/config.json
```

如进程意外退出留下 `.flux-gate.lock`，先确认没有仍在运行的发布操作、检查实际配置和 PM2 状态，再移除锁。不要盲目重试状态不明的发布。需要手动恢复时，使用已输出的备份文件还原 Tunnel 配置，运行原生校验后重启相同 Tunnel 进程；独立恢复入口应预先验证可用。

## HTTPS 与目标协议

公网 `https://demo.example.com` 可以指向目标 `http://192.168.1.10:3000`。浏览器到 Cloudflare 的 TLS 在 Cloudflare 边缘终止，其公网证书由 Cloudflare 管理和续期；Cloudflare 与本机 cloudflared 通过加密 Tunnel 通信。

Flux Gate 当前对 Web 目标固定使用 `http://`，目前不支持 HTTPS origin。公网使用 HTTPS 不要求本机目标安装 HTTPS 证书，也不意味着内部这段自动采用 TLS。loopback 目标使用 HTTP；跨局域网访问 HTTP 目标时，该内部网络段仍为明文，应按实际信任边界部署。若目标必须使用 HTTPS，需要另外实现并配置其证书信任。

TCP 转发不解释协议内的 TLS 或证书。数据库、SSH 等协议的身份认证和端到端加密由相应服务与客户端负责。

## 官方资料

- [Cloudflare Tunnel 支持的协议](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)：TCP、SSH 与客户端要求
- [客户端 cloudflared 连接 SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/)：SSH origin 和 ProxyCommand
