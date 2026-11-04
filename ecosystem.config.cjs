/**
 * 文件说明: 使用 PM2 守护 Flux Gate 的单实例生产进程。
 * 参考资料: README.md
 */
module.exports = {
  apps: [{
    name: 'flux-gate',
    cwd: __dirname,
    script: 'src/server.js',
    interpreter: 'node',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    time: true,
    env: { NODE_ENV: 'production' },
  }],
};
