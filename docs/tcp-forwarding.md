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

路由名称保存在 `description`。新建或编辑时，实际输入子域名会联动更新名称：先转为小写，将英文字母和数字之外的连续字符替换为空格，去掉首尾空格，再将各单词首字母大写，例如 `my-nas` → `My Nas`。打开编辑弹窗时保留已有名称；再次输入子域名才会触发联动，并覆盖当时的名称。名称也可手动填写或留空。

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
    "config_file": "/private/tunnels/forwarding.yml",
    "process_name": "forwarding-tunnel",
    "inventory_files": [
      { "label": "Management access", "config_file": "/private/tunnels/management.yml" }
    ]
  }
}
```

双 Tunnel 部署应显式填写业务配置路径和业务进程名。网关需要读取和写入业务配置，并能运行 `cloudflared` 与 `pm2`。网页请求不能指定文件路径或命令。

Cloudflare DNS 先把域名指向相应 Tunnel；流量到达部署主机上的 cloudflared 后，再按本地 ingress 从上到下匹配，命中第一条即停止。Gate 修改的是本地业务 Tunnel 配置，DNS 与云端 Tunnel 的归属需要另行配置。管理与业务的独立配置见下方双 Tunnel 部署步骤。

业务配置使用 block-list ingress。新增路由追加到现有受管路由之后，受管区块整体位于区块外规则与最终 404 回退之前；历史删除、改名的阻断规则排在当前路由之后。匹配范围较具体的规则应放在前面，通配等兜底规则放在后面，最终无 hostname 的回退必须放在最后。

业务域名和通配 DNS 必须指向业务 Tunnel。配置中的受管片段位于 `# BEGIN FLUX GATE ROUTES` 与 `# END FLUX GATE ROUTES` 之间。管理域名、通配规则、独立 SSH 恢复入口和其他区块外内容会保留。显式 hostname 与区块外规则冲突时停止发布。

当前本地配置型 Tunnel 的 ingress 没有单条 `disabled` 字段。暂停时保留本地路由的目标和认证配置，生成该 hostname 的 `http_status:404` 规则。同步完成后，由部署主机上的 cloudflared 直接返回 404，请求不再到达内网目标；界面保留完整链路与目标地址用于查看配置，不表示仍在转发。恢复使用本地保存的配置，不能仅凭 Tunnel 中的 404 反推出原目标或凭据。删除或改名后的受管 hostname 也保留为 404，避免被通配规则重新开放。需要重新使用域名时创建同名路由即可替换阻断规则。

## 自动同步

启用 Tunnel 集成后，新增、编辑、启用、暂停和删除都会自动同步公网接线。只有配置保存和 Tunnel 同步均完成，才返回成功。暂停保留业务配置并将域名阻断为 404，重新启用会恢复目标；删除后保留 404 规则，避免通配回退重新开放入口。

一次操作在串行队列与同一业务 Tunnel 排他锁中完成：校验路由、保存配置、生成原生 ingress、运行 `cloudflared tunnel ingress validate`、备份并原子替换配置、重启业务 Tunnel。同步失败会回退网关配置并核验旧接线。恢复无法确认时明确显示失败，需要检查主机；不会声称已启用或已暂停。

同步过程中旧公网接线可能短暂继续生效。例如直连切换密码保护，只有同步成功后才受 Gate 保护。界面展示当前链路与同步状态。内容没有变化时不会重复重启进程。集成未启用时仅保存本地配置，返回 `local_only`，不声称已更新公网。

业务配置备份位于运行用户的 `~/backups/flux-gate/tunnel/`，配置与备份使用 600 权限。运维 CLI 与自动同步使用同一文件锁；检测到外部配置并发变化会停止覆盖。进程意外退出留下 `.flux-gate.lock` 时，先确认没有发布仍在运行，再检查当前配置与业务进程状态后处理锁。

### 断线确认与重试

业务 Tunnel 重载可能中断该次 HTTP 请求。浏览器为每次写入生成 `X-Flux-Gate-Operation` 标识，通过 `GET /api/operations/:id` 读取同一操作回执，不盲目重发写请求。只有回执为 `applied` 且 `current: true` 才确认成功，包含仅修改密码的操作。

最近 20 个回执保存在网关配置旁的 `config.json.flux-gate-operations.json` 文件，使用 600 权限且不入 Git。回执包含非秘密操作 ID、状态和随机 revision，不保存请求正文或明文密码，也不向 API 暴露配置摘要或密码哈希。重复操作 ID 会被拒绝。

已确认回退的失败返回 `rolled_back` 和 `rollback_confirmed: true`，用户可明确重试，浏览器使用新 ID 重新提交内存中的原操作。无法确认、恢复失败或被更新覆盖时，只核验状态而不盲目重写。服务重启后未完成回执标为 `unknown`；配置与已确认接线不一致时明确显示同步未完成，需检查后重新保存或由运维恢复。

“已同步”表示业务接线与保存路由一致，配置全文哈希对应成功的重启记录。它不等于 DNS、Cloudflare Access、目标登录或业务流程已通过验收。

API `GET /api/tunnel` 返回期望 `rules`、已确认 `current_rules`、`current_verified` 和逐域名 `changes`。`changes` 包含 `desired_service`、`current_service`、`desired_path`、`current_path` 和 `status`。`GET /api/routes` 为数组，各路由提供 `target_service`、`tunnel_service`、相同的当前/期望路径、`current_verified` 与 `publication_status`；不会返回密码哈希。

管理页还会只读显示配置文件中的全部 ingress，包括管理域名、通配、独立 SSH、路径规则和最终回退。`existing_rules` 仅返回 `hostname`、`path`、`service` 与受管标识 `managed`；区块外入口没有编辑或接管操作。此视图表示文件已读取，运行状态仍取决于 `current_verified`，不能将读到文件视为服务已生效。集成停用或候选规则冲突时仍可读取现有配置；读取失败通过 `existing_rules_error` 显示，不回显 YAML 原文、凭据或请求头。

运维也可在主机执行同一发布逻辑；日常界面操作无需第二次应用：

```sh
node deploy/cloudflare-tunnel/apply-routes.cjs --config /absolute/path/to/flux-gate/config.json
```

恢复时先停止业务配置写入，将业务备份还原到原业务 Tunnel 路径，执行原生校验后重启相同业务进程。升级同时切换网关和 Tunnel 时，先恢复网关应用，再恢复匹配的业务接线。管理 Tunnel 保持原配置与进程，不参与业务恢复。

## 双 Tunnel 隔离

推荐为管理入口与业务转发使用两个独立的 Tunnel、配置文件和进程。管理域名、独立 SSH 恢复入口属于管理 Tunnel；业务域名与通配 DNS 指向业务 Tunnel。业务 Tunnel 最终使用 404 回退，管理域名和独立 SSH 使用显式 DNS 继续指向管理 Tunnel。

### 创建和运行两个 Tunnel

登录 Cloudflare 后，创建两个独立的 named Tunnel：

```sh
cloudflared tunnel login
cloudflared tunnel create management
cloudflared tunnel create forwarding
cloudflared tunnel route dns management example.com
cloudflared tunnel route dns management ssh.example.com
cloudflared tunnel route dns forwarding '*.example.com'
cloudflared tunnel route dns forwarding app.example.com
```

`ssh.example.com` 是可选的独立恢复入口，必须使用显式 DNS 指向管理 Tunnel，不能继承业务通配 DNS。已有显式业务记录也要指向业务 Tunnel；修改通配 DNS 不会自动覆盖显式记录。迁移已有域名时先保存原记录及回退方式，验证新 Tunnel 已连接，再切换相应记录。

每次创建命令都会输出独立 UUID 和本机凭据文件。将两份凭据各自保存在主机私密目录，权限设为 600；不要复制到项目仓库。分别创建以下配置，替换 UUID 和凭据绝对路径：

```yaml
# /private/tunnels/management.yml
tunnel: management-tunnel-id
credentials-file: /private/tunnels/management-credentials.json
ingress:
  - hostname: example.com
    service: http://127.0.0.1:8080
  - hostname: ssh.example.com
    service: ssh://127.0.0.1:22
  - service: http_status:404
```

```yaml
# /private/tunnels/forwarding.yml
tunnel: forwarding-tunnel-id
credentials-file: /private/tunnels/forwarding-credentials.json
ingress:
  - service: http_status:404
```

管理 Tunnel 的 SSH 规则仅在需要恢复入口、且目标 SSH 已按密钥鉴权时配置。业务规则由 Gate 自动写入第二份配置。先执行原生校验，再用独立进程运行：

```sh
cloudflared --config /private/tunnels/management.yml tunnel ingress validate
cloudflared --config /private/tunnels/forwarding.yml tunnel ingress validate
pm2 start cloudflared --name management-tunnel -- --config /private/tunnels/management.yml tunnel run management
pm2 start cloudflared --name forwarding-tunnel -- --config /private/tunnels/forwarding.yml tunnel run forwarding
pm2 save
```

将 Gate 的 `tunnel.config_file` / `process_name` 指向第二份配置和 `forwarding-tunnel`；`inventory_files` 指向第一份配置。完成公开管理登录、业务目标登录和独立恢复入口验收后，再按主机部署流程保存运行配置。

`config_file` 是唯一可修改的业务目标。`inventory_files` 只用于读取管理入口配置，不创建锁或备份、不改写、不重启其进程。业务主文件若与只读文件为相同路径、符号链接目标或硬链接，会拒绝同步。文件路径和进程名仅由部署者维护，网页请求不能覆盖。

API `inventories` 按业务 `forwarding` 与只读管理 `management` 分组；各组单独提供来源标签、规则、读取错误及核验状态。管理组规则始终只读，顶层接线与同步状态仅对应业务 Tunnel。

业务规则修改只重载业务 Tunnel，因此不会主动重载管理入口。但两个 Tunnel 若共用主机、网络或 Cloudflare 账户，仍会受到这些共享故障影响；独立 SSH key 与其他主机恢复方式仍需预先验收。

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
