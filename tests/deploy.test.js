/*
 * 文件说明: 在隔离服务目录运行真实发布入口，验证代码/运维资产切换、认证保留和失败恢复。
 * 对应文档: deploy/install-release.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

test('release switches operational assets and restores complete application after failed health check', { timeout: 25_000 }, async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flux-release-')));
  const target = path.join(dir, 'service'), bin = path.join(dir, 'bin'), pid = path.join(dir, 'pid');
  fs.mkdirSync(bin);
  const free = net.createServer();
  await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve));
  const port = free.address().port; await new Promise((resolve) => free.close(resolve));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, FLUX_TEST_TARGET: target, FLUX_TEST_PID: pid };
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pm2'), `#!${process.execPath}\nconst fs=require('fs'),p=require('path'),cp=require('child_process');
const target=process.env.FLUX_TEST_TARGET,pid=process.env.FLUX_TEST_PID;
(async()=>{const action=process.argv[2];if(action==='jlist'){console.log(JSON.stringify([{name:'flux-gate',pm2_env:{pm_cwd:target,pm_exec_path:p.join(target,'src/server.js')}}]));return;}
if(fs.existsSync(pid)){try{process.kill(Number(fs.readFileSync(pid)));}catch{} await new Promise(r=>setTimeout(r,50));fs.rmSync(pid,{force:true});}
if(action==='restart'){const child=cp.spawn(process.execPath,['src/server.js'],{cwd:target,stdio:'ignore',detached:true,env:process.env});fs.writeFileSync(pid,String(child.pid));child.unref();}})().catch(e=>{console.error(e);process.exitCode=1;});\n`, { mode: 0o755 });
  const config = JSON.stringify({ port, auth: { username: 'admin', password_hash: 'private' }, routes: [{ subdomain: 'app', no_password: true, ip: '127.0.0.1', port: 3000 }] });
  function application(root, label, failing = false) {
    for (const directory of ['src', 'node_modules', 'deploy/cloudflare-tunnel', 'docs']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/server.js'), `const fs=require('fs'),http=require('http');const cfg=JSON.parse(fs.readFileSync('config.json'));const server=http.createServer((q,s)=>{s.statusCode=${failing ? `process.cwd()===${JSON.stringify(target)}?500:401` : '401'};s.end();});server.listen(cfg.port,'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
    for (const file of ['package.json', 'package-lock.json', 'README.md', 'README.zh-CN.md', 'config.sample.json', 'docs/tcp-forwarding.md', 'deploy/cloudflare-tunnel/apply-routes.cjs']) fs.writeFileSync(path.join(root, file), file === 'package.json' ? '{}' : label);
  }
  application(target, 'old'); fs.writeFileSync(path.join(target, 'config.json'), config);
  t.after(() => {
    if (fs.existsSync(pid)) { try { process.kill(Number(fs.readFileSync(pid)), 'SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  execFileSync(path.join(bin, 'pm2'), ['restart', 'flux-gate'], { env });
  const release = path.join(dir, 'release'); application(release, 'current');
  const installer = path.join(__dirname, '../deploy/install-release.cjs');
  await run(process.execPath, [installer, release, target], { env });
  assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), 'current');
  assert.equal(fs.readFileSync(path.join(target, 'deploy/cloudflare-tunnel/apply-routes.cjs'), 'utf8'), 'current');
  assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), config);
  const bad = path.join(dir, 'bad'); application(bad, 'bad', true);
  await assert.rejects(run(process.execPath, [installer, bad, target], { env }), (error) => error.stderr.includes('prior service restored'));
  for (const file of ['README.md', 'deploy/cloudflare-tunnel/apply-routes.cjs', 'docs/tcp-forwarding.md']) assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), 'current');
  assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), config);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/routes`)).status, 401);
});
