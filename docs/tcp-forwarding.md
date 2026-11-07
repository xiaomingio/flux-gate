# Cloudflare Tunnel 的 SSH / TCP 接入

Flux Gate 应用代理 HTTP/WebSocket；非 HTTP 服务由同一台主机的 Cloudflare Tunnel 直接转发。SSH 入口绕过 Flux Gate 应用，不需要在网页创建路由，也不使用网关 Basic Auth。

当前部署真源是 `deploy/cloudflare-tunnel/ssh.json`，SSH 服务目标为运行 Tunnel 主机的 loopback 端口。主机连接信息从 Shell Utils 的 `hosts.yml` 解析，使用稳定 host ID `mac-mini`，不在这里复制账号和内网地址。

## 连接 Mac mini

客户端安装 Cloudflare 官方工具：

```sh
brew install cloudflared
```

内网可达时正常运行 `ssh mac-mini`。内网不可达时，在同一客户端使用既有 SSH key 和已核验的 Mac mini 主机指纹，经公网域名连接：

```sh
ssh -o BatchMode=yes -o PreferredAuthentications=publickey \
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
  -o StrictHostKeyChecking=yes \
  -o 'ProxyCommand=cloudflared access ssh --hostname ssh.iplab.cc' mac-mini
```

仍然以 `mac-mini` 作为 SSH 目标，保留现有用户、IdentityFile、端口和 known_hosts 匹配方式；ProxyCommand 替换传输路径。不要改成未知主机并关闭主机指纹校验。`scp -o ...` 和 `rsync -e 'ssh -o ...'` 可以使用同样的 SSH 选项。

此入口使用 SSH 公钥鉴权，未配置 Cloudflare Access，不需要浏览器登录或 service token。服务端统一关闭 SSH 密码及键盘交互认证；这不改变 macOS 账号密码、屏幕共享和其他服务的登录方式。

Cloudflare Tunnel 的公开 SSH / TCP 接入需要客户端 `cloudflared access ssh` 或 `cloudflared access tcp`，不能直接向域名的公网 22 端口运行普通 SSH。Cloudflare 官方客户端通过 HTTPS/WebSocket 承载流量；这项接线不承诺更高吞吐或更低延迟。长连接可能断开，远程写入仍需使用可恢复脚本，不盲目重跑状态不明的操作。

## 配置与上线

先完成下文 SSH 认证加固并验收，再发布公网入口。不要先把仍接受密码的 SSH 服务放到公网。

在 Mac mini 检查 `~/.cloudflared/config.yml`，将 `ssh.json` 的独立 hostname 规则置于 HTTP wildcard 规则之前。以下脚本只合并这条 SSH 规则，保留 Tunnel ID、凭据文件和其他 ingress；遇到同 hostname 的不同目标会停止。

```sh
node "$HOME/workspace/flux-gate/deploy/cloudflare-tunnel/apply-ssh.mjs" --key-only-verified
cloudflared --config "$HOME/.cloudflared/config.yml" tunnel ingress validate
cloudflared --config "$HOME/.cloudflared/config.yml" tunnel ingress rule https://ssh.iplab.cc
pm2 restart cloudflare-tunnel
```

当前域名的 wildcard DNS 已连接既有 Tunnel。部署后必须真实通过公网 ProxyCommand 新开 SSH key 登录，核对主机身份；再核对原 Flux Gate 管理入口和 Agent Beat HTTP 入口仍可用。`ingress validate`、域名解析和 TCP 端口可达都不能代替 SSH 登录验收。

若需恢复 Tunnel 配置，从脚本输出的 `$HOME/backups/cloudflare-tunnel/config/` 备份恢复 `~/.cloudflared/config.yml`，验证成功后只重启 `cloudflare-tunnel`。SSH 认证恢复使用下面的独立脚本。

## SSH 密码关闭与屏幕共享恢复

`deploy/ssh/` 提供 macOS 系统 SSH 加固、恢复和超时回退脚本。先把三个脚本放进 Mac mini 上一个新的批次目录，例如 `$HOME/backups/ssh-hardening/<批次>/`，在原 SSH 会话保持连接、屏幕共享可恢复的条件下执行：

```sh
sudo /bin/bash "$HOME/backups/ssh-hardening/<批次>/harden-macos.sh"
```

脚本只管理 `/etc/ssh/sshd_config.d/000-agent-beat-key-only.conf`，并检查主配置的 Include 顺序。修改前备份该文件的原有状态、保存主配置参考副本，并通过独立 root launchd 作业安排 180 秒自动回退。备份不包含 SSH 主机私钥。

校验包含 `sshd -t` 和 `sshd -T` 的默认及登录用户/loopback上下文，要求 `PubkeyAuthentication yes`、`PasswordAuthentication no`、`KbdInteractiveAuthentication no` 和 `AuthenticationMethods publickey`。Mac mini 使用 launchd 按连接启动 sshd，新连接读取新配置；脚本不重启 SSH、不关闭 Remote Login，也不操作屏幕共享。

安装成功后立即从客户端新开一个独立 SSH key 连接，再以 `PreferredAuthentications=none`、`PubkeyAuthentication=no` 请求认证，检查服务端只提供 `publickey`。两项通过后，在新连接里执行脚本打印的 `touch <批次目录>/confirmed`；独立回退作业确认文件属于原登录用户后取消自动恢复，写入 `rollback-cancelled`。没有确认就会自动还原。

如果新连接失败，保持原会话并等待自动回退；也可通过 Mac mini 屏幕共享打开终端，执行事先已放到主机上的恢复脚本：

```sh
sudo /bin/bash "$HOME/backups/ssh-hardening/<批次>/restore-macos.sh"
```

恢复脚本只还原本批次管理的 SSH 文件，运行 `sshd -t`，并显示恢复后的认证配置。用户在屏幕共享中输入自己的 sudo 密码；不要把密码写进提示词、脚本或日志。

## 官方资料

- [通过客户端 cloudflared 连接 SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/)：SSH origin 和 ProxyCommand
- [Tunnel ingress 支持的协议](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)：SSH、TCP 与客户端要求
