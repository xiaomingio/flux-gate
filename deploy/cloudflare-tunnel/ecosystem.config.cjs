/**
 * 文件说明: 使用 PM2 守护连接 Flux Gate 的 Cloudflare Tunnel。
 * 参考资料: README.md
 */
const os = require('node:os');
const path = require('node:path');

module.exports = {
  apps: [{
    name: 'cloudflare-tunnel',
    cwd: __dirname,
    script: 'cloudflared',
    args: ['--config', path.join(os.homedir(), '.cloudflared', 'config.yml'), 'tunnel', 'run'],
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    time: true,
  }],
};
