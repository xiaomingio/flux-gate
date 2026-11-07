/*
 * 文件说明: 验证 Tunnel 受控片段发布、无关规则保护、失败回退和实际配置状态比对。
 * 对应文档: docs/tcp-forwarding.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const YAML = require('yaml');
const TunnelConfig = require('../src/TunnelConfig');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-tunnel-'));
  t.mock.method(os, 'homedir', () => dir);
  const file = path.join(dir, 'config.yml');
  const original = 'tunnel: example-id\ncredentials-file: /private/credentials.json\nprotocol: http2\ningress:\n  # Independent recovery entry stays outside managed section.\n  - hostname: recovery.example.com\n    service: ssh://127.0.0.1:22\n  - hostname: "*.example.com"\n    service: http://127.0.0.1:8080\n  - service: http_status:404\n';
  fs.writeFileSync(file, original);
  const config = { baseDomain: 'example.com', tunnel: { enabled: true, config_file: file }, routes: [
    { type: 'tcp', subdomain: 'db', listen_port: 15432, ip: '127.0.0.1', port: 5432 },
  ] };
  const store = { loadConfig: () => structuredClone(config) };
  const tunnel = new TunnelConfig(store);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file, original, config, tunnel };
}

test('TCP Tunnel publishing preserves every unmanaged ingress and tracks changes', async (t) => {
  const { file, original, config, tunnel } = fixture(t);
  const calls = [];
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => { calls.push({ command, args }); queueMicrotask(() => callback(null)); });
  assert.equal(tunnel.status().status, 'pending');
  assert.equal((await tunnel.apply()).status, 'applied');
  const updated = fs.readFileSync(file, 'utf8');
  const before = YAML.parse(original), after = YAML.parse(updated);
  assert.deepEqual(after.ingress.slice(1), before.ingress);
  assert.deepEqual(after.ingress[0], { hostname: 'db.example.com', service: 'tcp://127.0.0.1:15432' });
  assert.equal(after['credentials-file'], before['credentials-file']);
  assert.equal(calls[0].command, 'cloudflared'); assert.deepEqual(calls[1], { command: 'pm2', args: ['restart', 'cloudflare-tunnel'] });
  config.routes[0].disabled = true;
  assert.equal(tunnel.status().status, 'pending');
  assert.equal((await tunnel.apply()).status, 'applied');
  assert.deepEqual(YAML.parse(fs.readFileSync(file, 'utf8')).ingress, before.ingress);
});

test('validation failure leaves config untouched, process restart failure restores original and clears receipt', async (t) => {
  const { file, original, tunnel } = fixture(t);
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => queueMicrotask(() => callback(new Error('validation failed'))));
  await assert.rejects(tunnel.apply(), /validation failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(`${file}.flux-gate.lock`), false);
  let restarts = 0;
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    queueMicrotask(() => callback(command === 'pm2' && restarts++ === 0 ? new Error('restart failure') : null));
  });
  await assert.rejects(tunnel.apply(), /restart failed/);
  assert.equal(restarts, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(tunnel.status().status, 'pending');
  assert.equal(fs.existsSync(`${file}.flux-gate-applied.json`), false);
});

test('overlapping unmanaged hostnames, concurrent publish and external configuration edits are protected', async (t) => {
  const { config, file, tunnel } = fixture(t);
  config.routes[0].subdomain = 'recovery';
  assert.equal(tunnel.status().status, 'error');
  await assert.rejects(tunnel.apply(), /unmanaged/);
  config.routes[0].subdomain = 'db';
  let resume;
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => { resume = callback; });
  const first = tunnel.apply();
  await assert.rejects(tunnel.apply(), /already running/);
  fs.appendFileSync(file, '# external change\n');
  resume(null);
  await assert.rejects(first, /changed concurrently/);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('# external change\n'));
});
