# 管理端登录

管理端使用独立表单登录和服务端会话。打开根路径会跳转 `/login`，使用 `config.json` 中的 `auth.username` 与对应密码。现有 SHA256 密码哈希继续有效。首次启动的本地默认账号仍为 `admin/admin`，上线前应修改密码。

登录后固定有效 30 天，浏览器 Cookie 与服务端记录同时到期；重启不延长或中断有效期。退出或修改管理凭据会提前失效。修改密码后需要重新登录。管理页面和 API 都检查会话；未登录页面跳转登录页，API 返回 401。管理端不接受 Basic Auth 登录。

会话存放在配置文件旁的 `<configFile>.flux-gate-sessions.json`，权限为 `0600`，通过临时文件原子更新。文件保存会话令牌的 SHA256 摘要、到期时间、CSRF 令牌及凭据指纹，不保存原始会话令牌或密码。保留该文件可维持重启后的登录状态；不要提交或公开它。若文件损坏，服务拒绝启动，不静默接受未知会话。每个进程独占此文件，服务应以单实例运行。

Cookie 为 `flux_gate_session`，使用 `Path=/`、`HttpOnly`、`SameSite=Lax`，不设置跨子域的 Domain。HTTPS 请求设置 `Secure`。服务仅信任 loopback 代理传入的协议与转发主机；cloudflared 应从本机连接 Gate，并保留浏览器 Host。其他反向代理拓扑应先明确可信代理网段，再调整配置；不要无条件信任公网传入的转发头。

登录表单先取得有效 10 分钟的匿名会话与 CSRF 令牌，成功后轮换为全新的管理会话。每个来源 IP 在 15 分钟内连续失败 10 次后，登录返回 429 及 `Retry-After`。匿名会话与已登录会话分别限制容量，匿名访问不能挤掉有效登录。

所有管理写操作，包括登录、退出和密码变更，都要求 CSRF 令牌。表单提交 `_csrf`，JSON 请求使用 `X-CSRF-Token`；已登录客户端可从 `GET /api/session` 取得 `{username, csrfToken}`。若请求携带 Origin，必须与服务端识别的完整协议和 Host 一致；跨站 Fetch Metadata 同样被拒绝。API 客户端需要先完成登录并保存 Cookie，然后携带该会话的 CSRF 令牌，不能用 Basic Auth 替代。

主页面在产品介绍下展示业务转发、只读管理入口两张卡片。路由添加、编辑和设置使用弹窗，不切换独立页面。地球图标展开中英文菜单；退出按钮先确认，取消不发出退出请求。

主页面的设置弹窗通过 `POST /settings/password` 提交当前密码、新密码及确认密码；验证失败返回 400 与 `{error}`，成功返回 `{ok:true, redirect:"/login"}` 并撤销会话。旧 `GET /settings` 返回 303，跳转 `/?settings=open` 打开同一弹窗，不再提供独立设置页。

退出使用 `POST /logout`，清除服务端记录及相同 Path 的 Cookie。登录成功和退出均返回 303。`next` 只接受本站绝对路径，外站 URL 或双斜线地址回到根路径。

管理会话不能授权转发服务。HTTP 密码保护路由仍逐请求通过原有 Basic Auth middleware，包括 WebSocket 升级。它们使用自定义路由凭据，或默认管理凭据；修改默认密码也会影响使用默认凭据的转发路由。HTTP 直连与 TCP 继续由 Tunnel 直接连接目标，其认证由目标服务承担。
