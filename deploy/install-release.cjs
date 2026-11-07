#!/usr/bin/env node
/*
 * 文件说明: 验证暂存发布包，备份切换源码、依赖及运维入口，保留配置并在失败时恢复。
 * 对应文档: docs/tcp-forwarding.md
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');

async function run(command, args, cwd) {
  return new Promise((resolve, reject) => childProcess.execFile(command, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${command} failed; inspect the release directory and service logs`));
    else resolve(stdout);
  }));
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return port;
}
async function healthy(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/routes`, { signal: AbortSignal.timeout(1000) }); if (response.status === 401) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Gateway did not return the expected authentication challenge');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3 || !args.slice(0, 2).every(path.isAbsolute) ||
      (args[2] && args[2] !== '--enable-tunnel')) throw new Error('Usage: install-release.cjs /absolute/release /absolute/service [--enable-tunnel]');
  const release = fs.realpathSync(args[0]), target = fs.realpathSync(args[1]);
  if (release === target || release.startsWith(target + path.sep) || target.startsWith(release + path.sep)) throw new Error('Release and service must be separate directories');
  for (const file of ['src/server.js', 'deploy/cloudflare-tunnel/apply-routes.cjs', 'docs/tcp-forwarding.md', 'package.json', 'package-lock.json']) {
    if (!fs.statSync(path.join(release, file)).isFile()) throw new Error(`Release is missing ${file}`);
  }
  const configFile = path.join(target, 'config.json');
  const originalText = fs.readFileSync(configFile, 'utf8'), config = JSON.parse(originalText);
  const topology = JSON.parse(await run('pm2', ['jlist'], target)).find((entry) => entry.name === 'flux-gate');
  if (!topology || fs.realpathSync(topology.pm2_env.pm_cwd) !== target ||
      topology.pm2_env.pm_exec_path !== path.join(target, 'src/server.js')) throw new Error('Existing flux-gate PM2 process does not belong to this service');
  await run('npm', ['ci', '--omit=dev'], release);
  await run('npm', ['audit', '--omit=dev'], release);
  if (config.tunnel?.enabled) {
    const Route = require(path.join(release, 'src/Route'));
    const TunnelConfig = require(path.join(release, 'src/TunnelConfig'));
    const direct = (config.routes || []).filter((route) => new Route(route).path === 'direct');
    if (direct.length) {
      const status = new TunnelConfig({ loadConfig: () => JSON.parse(fs.readFileSync(configFile, 'utf8')) }).status();
      if (!status.current_verified || direct.some((route) => !status.changes.some((change) =>
        change.hostname === `${route.subdomain}.${config.baseDomain}` && change.status === 'applied'))) {
        throw new Error('Apply and verify the release Tunnel routes before switching an application with direct services');
      }
    }
  }
  const smokePort = await freePort();
  const smokeConfig = { ...config, port: smokePort, routes: (config.routes || []).map((route) => ({ ...route, disabled: true })), tunnel: { enabled: false } };
  if (fs.existsSync(path.join(release, 'config.json'))) throw new Error('Release staging must not contain a live config.json');
  fs.writeFileSync(path.join(release, 'config.json'), JSON.stringify(smokeConfig), { mode: 0o600, flag: 'wx' });
  const smoke = childProcess.spawn(process.execPath, ['src/server.js'], { cwd: release, stdio: 'ignore' });
  smoke.on('error', () => {});
  try { await healthy(smokePort); }
  finally {
    const exited = new Promise((resolve) => { if (smoke.exitCode !== null || smoke.signalCode !== null) resolve(); else smoke.once('exit', resolve); });
    smoke.kill('SIGTERM'); await exited;
    fs.unlinkSync(path.join(release, 'config.json'));
  }
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).replace(/\D/g, '');
  const backup = path.join(os.homedir(), 'backups/flux-gate/application', `${stamp}-${crypto.randomUUID()}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const copied = ['package.json', 'package-lock.json', 'config.json', 'README.md', 'README.zh-CN.md', 'config.sample.json'];
  const existed = copied.filter((file) => fs.existsSync(path.join(target, file)));
  for (const file of existed) {
    fs.copyFileSync(path.join(target, file), path.join(backup, file));
    fs.chmodSync(path.join(backup, file), 0o600);
  }
  console.log(`Release recovery package: ${backup}`);
  if (fs.readFileSync(configFile, 'utf8') !== originalText) throw new Error('Service configuration changed during preparation; abort before switching');
  const moved = [];
  await run('pm2', ['stop', 'flux-gate'], target);
  if (fs.readFileSync(configFile, 'utf8') !== originalText) {
    await run('pm2', ['restart', 'flux-gate'], target);
    throw new Error('Service configuration changed before switch; latest configuration kept');
  }
  try {
    for (const name of ['src', 'node_modules', 'deploy', 'docs']) {
      const present = fs.existsSync(path.join(target, name));
      if (present) fs.renameSync(path.join(target, name), path.join(backup, name));
      moved.push({ name, present });
      fs.renameSync(path.join(release, name), path.join(target, name));
    }
    for (const file of copied.filter((file) => file !== 'config.json')) fs.copyFileSync(path.join(release, file), path.join(target, file));
    if (args[2]) {
      config.tunnel = { ...(config.tunnel || {}), enabled: true };
      const temporary = `${configFile}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, configFile);
    }
    await run('pm2', ['restart', 'flux-gate'], target);
    await healthy(Number(config.port) || 8080);
    const current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const original = JSON.parse(originalText);
    for (const field of ['auth', 'routes']) if (JSON.stringify(current[field]) !== JSON.stringify(original[field])) throw new Error('Protected configuration changed during release');
    fs.writeFileSync(path.join(backup, 'release-complete'), 'Gateway restarted and authentication challenge verified.\n', { mode: 0o600 });
    console.log('Gateway release complete. Existing route and authentication configuration preserved.');
  } catch (error) {
    for (const { name, present } of moved.reverse()) {
      if (fs.existsSync(path.join(target, name))) fs.renameSync(path.join(target, name), path.join(backup, `failed-${name}`));
      if (present) fs.renameSync(path.join(backup, name), path.join(target, name));
    }
    for (const file of copied) {
      if (existed.includes(file)) fs.copyFileSync(path.join(backup, file), path.join(target, file));
      else if (fs.existsSync(path.join(target, file))) fs.unlinkSync(path.join(target, file));
    }
    await run('pm2', ['restart', 'flux-gate'], target);
    await healthy(Number(config.port) || 8080);
    throw new Error(`${error.message}; prior service restored from ${backup}`);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
