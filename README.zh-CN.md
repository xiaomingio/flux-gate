# 🌐 Flux Gate

[English](README.md) | **简体中文**

通过 Cloudflare Tunnel 发布 HTTP 与 TCP 服务的自建管理面板。需要为 HTTP 服务增加密码保护时，才经过 Flux Gate 网关。

![管理界面](assets/admin.png)

## 它能做什么

Flux Gate 可以帮你：
- 通过 Cloudflare Tunnel 暴露内网 Web 服务
- 用不同子域名转发到不同服务
- 通过 Web 界面管理路由
- 用默认账号密码保护管理后台和转发服务，并支持为单个转发项单独覆盖
- 支持给每个转发项单独设置用户名和密码或无密码
- 支持暂停和启用每个转发项目
- 支持管理面板中英文切换
- 使用 Cloudflare Tunnel 原生 ingress 直达 HTTP 与 TCP 目标
- 自动同步公网接线，包含校验、备份和失败回退

示例：
- `https://your-domain.com` → 管理后台
- `https://demo.your-domain.com` → 你的内网服务

路由分为三种模式：

| 模式 | 请求链路 |
| --- | --- |
| HTTP 密码保护 | Cloudflare → cloudflared → Flux Gate Basic Auth → 目标 |
| HTTP 直连 | Cloudflare → cloudflared → 目标 |
| TCP 直连 | 访问端 cloudflared → Cloudflare → 服务端 cloudflared → 目标 |

TCP 直连仅指服务端 cloudflared 跳过 Gate 连接目标；访问端仍需 cloudflared，SSH 可通过 ProxyCommand 自动调用它，并非开放任意公网 TCP 端口。配置方法见 [TCP 客户端](docs/tcp-forwarding.md#tcp-客户端)。

保存、启用、暂停和删除会自动同步业务 Tunnel，同步完成后才确认公网生效；未配置业务 Tunnel 时只保存本地配置，界面显示“未配置业务 Tunnel”。直连服务使用自身的认证。配置与发布流程见 [路由与 Tunnel 发布](docs/tcp-forwarding.md)。

公网 `https://demo.example.com` 可以转发到内网 `http://192.168.1.10:3000`。Cloudflare 管理公网证书并终止浏览器 TLS，与 cloudflared 通过加密 Tunnel 通信。Flux Gate 当前固定使用 `http://` 连接 Web 目标，目前不支持 HTTPS origin；内部 HTTP 段不会自动变成 TLS，也不需要本机证书。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 创建配置文件

```bash
cp config.sample.json config.json
```

### 3. 编辑配置

```json
{
  "port": 8080,
  "baseDomain": "your-domain.com",
  "auth": {
    "username": "admin",
    "password_hash": ""
  },
  "routes": [
    {
      "subdomain": "demo",
      "ip": "192.168.1.100",
      "port": "3000",
      "description": "Demo service",
      "username": "",
      "password_hash": "",
      "no_password": false,
      "disabled": false
    }
  ]
}
```

字段说明：
- `port`：管理后台端口
- `baseDomain`：Cloudflare 管理的主域名
- `auth.username`：管理端表单登录用户名，同时作为 HTTP 密码保护路由的默认凭据
- `auth.password_hash`：密码的 SHA256 哈希；留空时首次启动默认 `admin/admin`
- `routes`：子域名转发规则列表
- `routes[].username` / `routes[].password_hash`：成对的 HTTP 自定义凭据；均不填时使用默认凭据。界面/API 保存自定义认证时，两项必填；编辑时也需重新填写密码。
- `routes[].type`：`http`（默认）或 `tcp`
- `routes[].no_password`：仅 HTTP；`true` 由 Tunnel 直达目标，`false` 经 Gate Basic Auth
- `routes[].disabled`：保留路由并自动同步 404 规则，阻断其公网域名

生成密码哈希：

```bash
node -e "console.log(require('crypto').createHash('sha256').update('你的密码').digest('hex'))"
```

### 4. 配置两个独立 Tunnel

按[双 Tunnel 接线指南](docs/tcp-forwarding.md#双-tunnel-隔离)配置：管理域名和可选的独立恢复域名使用管理 Tunnel；业务通配和业务域名使用业务 Tunnel。在 Gate 中设置业务 `config_file` / `process_name`，并用只读 `inventory_files` 展示管理配置。

### 5. 启动网关

```bash
npm start
# 或持久运行：
pm2 start src/server.js --name flux-gate
pm2 save
```

接线指南包含两个独立 cloudflared 进程、凭据、DNS、自动同步和恢复步骤。真实凭据仅保留在部署主机。

## 使用管理面板

页面顶部保留产品介绍，下方为业务转发和管理入口两张规则卡片。业务转发由 Gate 管理，每条路由只显示一次，同时展示实际 Tunnel 状态。管理入口及其他非 Gate 管理的规则保持只读。

添加和编辑路由都在弹窗中完成。设置图标打开修改密码弹窗，修改成功后需重新登录；退出前会确认。地球图标打开中英文菜单。旧 `/settings` 地址仅跳转到 `/?settings=open`，打开同一设置弹窗。

管理端通过 `/login` 表单登录，服务端会话固定有效 30 天，重启保留。退出或变更凭据后提前失效。管理 API 写入需要会话 Cookie 和 CSRF 令牌。转发服务继续使用独立的 HTTP Basic Auth。存储、可信代理及 API 用法见[管理端登录](docs/admin-auth.md)。

## 默认账号

- 用户名：`admin`
- 密码：`admin`

首次部署后请立即修改。

## 安全提醒

Flux Gate 会把内网服务发布到公网。

请不要暴露这些内容：
- 数据库
- 缺少额外保护的管理后台
- 文件系统或私有面板
- 含敏感数据的服务（除非已做好安全防护）

请使用强密码，只发布真正需要对外访问的服务。

## 常见问题

### 子域名访问不了怎么办？
先检查这几个地方：
1. `cloudflared` 是否已启动
2. 是否配置了通配符 DNS：`*.your-domain.com`
3. 目标 IP 和端口是否正确
4. 目标服务是否真的在运行

### 怎么添加新路由？
登录管理后台，打开添加路由弹窗，填写子域名 / IP / 端口并保存即可。你也可以为单个转发项设置独立用户名密码、开启无密码访问，或者直接停用该转发项。所有模式的修改都会自动保存并同步。Tunnel 重载断线时，界面只读核验原操作回执；已确认回退的失败可明确重试。

## License

ISC
