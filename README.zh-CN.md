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
- 显式应用公网接线，包含校验、备份和失败回退

示例：
- `https://your-domain.com` → 管理后台
- `https://demo.your-domain.com` → 你的内网服务

路由分为三种模式：

| 模式 | 请求链路 |
| --- | --- |
| HTTP 密码保护 | Cloudflare → cloudflared → Flux Gate Basic Auth → 目标 |
| HTTP 直连 | Cloudflare → cloudflared → 目标 |
| TCP 直连 | Cloudflare 客户端 → Cloudflare → cloudflared → 目标 |

保存配置后，点击“应用到 Tunnel”更新公网入口。应用成功前，旧入口可能继续生效。直连服务使用自身的认证。配置与发布流程见 [路由与 Tunnel 发布](docs/tcp-forwarding.md)。

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
- `auth.username`：登录用户名
- `auth.password_hash`：密码的 SHA256 哈希；留空时首次启动默认 `admin/admin`
- `routes`：子域名转发规则列表
- `routes[].username` / `routes[].password_hash`：成对的 HTTP 自定义凭据；均不填时使用默认凭据。界面/API 保存自定义认证时，两项必填；编辑时也需重新填写密码。
- `routes[].type`：`http`（默认）或 `tcp`
- `routes[].no_password`：仅 HTTP；`true` 由 Tunnel 直达目标，`false` 经 Gate Basic Auth
- `routes[].disabled`：保存为停用；应用到 Tunnel 后才会阻断其公网域名

生成密码哈希：

```bash
node -e "console.log(require('crypto').createHash('sha256').update('你的密码').digest('hex'))"
```

### 4. 准备 Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create my-tunnel
cloudflared tunnel route dns my-tunnel your-domain.com
cloudflared tunnel route dns my-tunnel "*.your-domain.com"
```

按[接线指南](docs/tcp-forwarding.md#tunnel-integration)创建 Tunnel ingress，并启用集成。

### 5. 启动服务

终端 1：

```bash
npm start
```

终端 2：

```bash
cloudflared tunnel run my-tunnel
```

## 用 PM2 运行

```bash
pm2 start src/server.js --name flux-gate
pm2 start cloudflared --name cloudflare-tunnel -- tunnel run my-tunnel
pm2 save
```

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
打开管理后台，填写子域名 / IP / 端口并保存即可。你也可以为单个转发项设置独立用户名密码、开启无密码访问，或者直接停用该转发项。所有模式的修改都会写入 `config.json`，随后需点击“应用到 Tunnel”更新公网接线。直连切换为密码保护时，应用成功前旧的公网直连仍然可用。

## License

ISC
