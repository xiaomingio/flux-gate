# 🌐 Flux Gate

**English** | [简体中文](README.zh-CN.md)

A self-hosted control panel for publishing HTTP and TCP services through Cloudflare Tunnel. Add a password-protection gateway only to HTTP routes that need it.

![](assets/admin.png)

## What it does

Flux Gate lets you:
- expose internal web services through Cloudflare Tunnel
- route different services with different subdomains
- manage routes from a web UI
- protect the admin panel and routed services with default credentials, while allowing per-route overrides
- optionally set a custom username/password or no password for each forwarded route
- pause and re-enable each forwarded route individually
- switch the dashboard between Chinese and English
- connect HTTP and TCP targets directly through native Cloudflare Tunnel ingress
- explicitly apply routing changes with validation, backups and rollback

Example:
- `https://your-domain.com` → admin panel
- `https://demo.your-domain.com` → your internal service

Choose one of three route modes:

| Mode | Request path |
| --- | --- |
| HTTP with password protection | Cloudflare → cloudflared → Flux Gate Basic Auth → target |
| Direct HTTP | Cloudflare → cloudflared → target |
| Direct TCP | Cloudflare client → Cloudflare → cloudflared → target |

Save the configuration, then apply it to Tunnel. Until application succeeds, previous public ingress can remain active. Direct services use their own authentication. See [routing and Tunnel publishing](docs/tcp-forwarding.md).

A public HTTPS URL such as `https://demo.example.com` can forward to an internal HTTP target such as `http://192.168.1.10:3000`. Cloudflare manages the public certificate and terminates browser TLS; its connection to cloudflared uses an encrypted Tunnel. Flux Gate currently uses `http://` for web targets; HTTPS origins are not supported. The internal HTTP segment does not become TLS automatically and does not require a local certificate.

## Quick start

### 1. Install

```bash
npm install
```

### 2. Create config

```bash
cp config.sample.json config.json
```

### 3. Edit config

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

Field summary:
- `port`: admin server port
- `baseDomain`: your main domain managed by Cloudflare
- `auth.username`: login username
- `auth.password_hash`: SHA256 password hash; empty means first run uses `admin/admin`
- `routes`: list of subdomain forwarding rules
- `routes[].username` / `routes[].password_hash`: pair of custom HTTP credentials; omit both for default credentials. Custom saves in the UI/API require both a username and a freshly entered password, including edits.
- `routes[].type`: `http` (default) or `tcp`
- `routes[].no_password`: HTTP only; `true` connects Tunnel directly to the target, `false` routes through Gate Basic Auth
- `routes[].disabled`: saves a blocked route; apply to Tunnel to block its public hostname

To generate a password hash:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('your-password').digest('hex'))"
```

### 4. Prepare Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create my-tunnel
cloudflared tunnel route dns my-tunnel your-domain.com
cloudflared tunnel route dns my-tunnel "*.your-domain.com"
```

Create the Tunnel ingress and enable the integration using the [routing guide](docs/tcp-forwarding.md#tunnel-integration).

### 5. Start services

Terminal 1:

```bash
npm start
```

Terminal 2:

```bash
cloudflared tunnel run my-tunnel
```

## Run with PM2

```bash
pm2 start src/server.js --name flux-gate
pm2 start cloudflared --name cloudflare-tunnel -- tunnel run my-tunnel
pm2 save
```

## Default login

- Username: `admin`
- Password: `admin`

Change it immediately after first deployment.

## Safety notes

Flux Gate publishes internal services to the public internet.

Please avoid exposing:
- databases
- admin tools without extra protection
- file systems or private dashboards
- anything with sensitive data unless properly secured

Use strong passwords and only publish what you really need.

## Troubleshooting

### A subdomain does not work
Check these first:
1. `cloudflared` is running
2. wildcard DNS (`*.your-domain.com`) is configured
3. the target IP and port are correct
4. the target service is actually running

### How do I add a new route?
Open the admin panel, fill in subdomain / IP / port, and save it. You can also edit route-specific username/password, allow no password, or disable the route. Changes are saved to `config.json`; click Apply to Tunnel to update public ingress for every mode. A direct route switched to password protection remains directly accessible until application succeeds.

## License

ISC
