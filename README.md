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
- automatically synchronize routing changes with validation, backups and rollback

Example:
- `https://your-domain.com` → admin panel
- `https://demo.your-domain.com` → your internal service

Choose one of three route modes:

| Mode | Request path |
| --- | --- |
| HTTP with password protection | Cloudflare → cloudflared → Flux Gate Basic Auth → target |
| Direct HTTP | Cloudflare → cloudflared → target |
| Direct TCP | Client-side cloudflared → Cloudflare → server-side cloudflared → target |

Direct TCP means server-side cloudflared connects to the target without Gate. The connecting client still needs cloudflared, which SSH can invoke through ProxyCommand; it does not expose arbitrary public TCP ports. Client setup is covered in the [routing guide](docs/tcp-forwarding.md#tcp-客户端).

Save, pause, resume and delete operations automatically synchronize the business Tunnel. Public synchronization is confirmed only after it completes. If the business Tunnel is not configured, changes remain local and the dashboard shows that state. Direct services use their own authentication. See [routing and Tunnel publishing](docs/tcp-forwarding.md).

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
- `auth.username`: admin form-login username and default credentials for protected HTTP routes
- `auth.password_hash`: SHA256 password hash; empty means first run uses `admin/admin`
- `routes`: list of subdomain forwarding rules
- `routes[].username` / `routes[].password_hash`: pair of custom HTTP credentials; omit both for default credentials. Custom saves in the UI/API require both a username and a freshly entered password, including edits.
- `routes[].type`: `http` (default) or `tcp`
- `routes[].no_password`: HTTP only; `true` connects Tunnel directly to the target, `false` routes through Gate Basic Auth
- `routes[].disabled`: keeps the route saved and synchronizes a 404 rule for its public hostname

To generate a password hash:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('your-password').digest('hex'))"
```

### 4. Configure separate Tunnels

Follow the [dual-Tunnel setup](docs/tcp-forwarding.md#双-tunnel-隔离): keep the management domain and optional explicit recovery hostname on one Tunnel, and business wildcard/hostnames on the other. Set the writable business `config_file` / `process_name` and read-only management `inventory_files` in Gate configuration.

### 5. Start the gateway

```bash
npm start
# Or run persistently:
pm2 start src/server.js --name flux-gate
pm2 save
```

The routing guide covers the two independent cloudflared processes, credentials, DNS, automatic synchronization and recovery. Credentials remain private on the deployment host.

## Using the dashboard

The dashboard keeps the introduction above two rule cards: business forwarding managed by Gate, and read-only management access. Each business route appears once alongside its actual Tunnel state; rules outside Gate ownership remain read-only.

Add and edit routes in a dialog. The settings icon opens the password dialog; a successful change signs you out and returns you to login. Logout asks for confirmation. The globe icon opens the Chinese/English language menu. The old `/settings` URL redirects to `/?settings=open`, which opens the same dialog.

Management uses a persistent 30-day server session, separate from forwarded HTTP Basic Auth. Logout and credential changes revoke access. API writes require the session Cookie and CSRF token. See [admin authentication](docs/admin-auth.md) for storage, trusted proxy and API details.

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
Open the admin panel and sign in through `/login`, then open the add-route dialog, fill in subdomain / IP / port, and save it. You can also edit route-specific username/password, allow no password, or disable the route. Changes are saved and synchronized automatically. If the request disconnects during Tunnel reload, the UI reads its operation receipt instead of repeating the write. Confirmed rollback failures can be retried explicitly.

## License

ISC
