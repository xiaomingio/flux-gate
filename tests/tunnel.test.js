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
    { type: 'tcp', subdomain: 'db', ip: '127.0.0.1', port: 5432 },
  ] };
  const store = { loadConfig: () => structuredClone(config) };
  const tunnel = new TunnelConfig(store);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file, original, config, tunnel };
}

test('native TCP publishing preserves unmanaged ingress and blocks disabled and removed hosts', async (t) => {
  const { file, original, config, tunnel } = fixture(t);
  const calls = [];
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => { calls.push({ command, args }); queueMicrotask(() => callback(null)); });
  assert.equal(tunnel.status().status, 'pending');
  assert.equal((await tunnel.apply()).status, 'applied');
  const updated = fs.readFileSync(file, 'utf8');
  const before = YAML.parse(original), after = YAML.parse(updated);
  assert.deepEqual(after.ingress.slice(1), before.ingress);
  assert.deepEqual(after.ingress[0], { hostname: 'db.example.com', service: 'tcp://127.0.0.1:5432' });
  assert.equal(after['credentials-file'], before['credentials-file']);
  assert.equal(calls[0].command, 'cloudflared'); assert.deepEqual(calls[1], { command: 'pm2', args: ['restart', 'cloudflare-tunnel'] });
  config.routes[0].disabled = true;
  assert.equal(tunnel.status().status, 'pending');
  assert.equal((await tunnel.apply()).status, 'applied');
  assert.deepEqual(YAML.parse(fs.readFileSync(file, 'utf8')).ingress[0], { hostname: 'db.example.com', service: 'http_status:404' });
  config.routes = [];
  assert.equal((await tunnel.apply()).status, 'applied');
  assert.deepEqual(YAML.parse(fs.readFileSync(file, 'utf8')).ingress[0], { hostname: 'db.example.com', service: 'http_status:404' });
});

test('HTTP direct and password-protected paths publish the correct Host behavior and report protection pending', async (t) => {
  const { config, file, tunnel } = fixture(t);
  config.routes = [{ subdomain: 'web', ip: '::1', port: 3000, no_password: true }];
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => queueMicrotask(() => callback(null)));
  await tunnel.apply();
  assert.deepEqual(tunnel.status().rules[0], { hostname: 'web.example.com', service: 'http://[::1]:3000', originRequest: { httpHostHeader: '[::1]:3000' } });
  config.routes[0].no_password = false;
  let status = tunnel.status();
  assert.equal(status.current_verified, true);
  assert.deepEqual(status.changes[0], { hostname: 'web.example.com', desired_service: 'http://127.0.0.1:8080', current_service: 'http://[::1]:3000', desired_path: 'gateway', current_path: 'direct', status: 'pending' });
  await tunnel.apply();
  assert.deepEqual(tunnel.status().rules[0], { hostname: 'web.example.com', service: 'http://127.0.0.1:8080' });
  assert.equal(tunnel.status().changes[0].current_path, 'gateway');
  fs.appendFileSync(file, '# external edit\n');
  status = tunnel.status();
  assert.equal(status.current_verified, false); assert.equal(status.changes[0].current_path, 'unknown');
});

test('legacy managed block migrates once and renamed public hosts stay explicitly blocked', async (t) => {
  const { original, file, config, tunnel } = fixture(t);
  fs.writeFileSync(file, original.replace('ingress:\n', 'ingress:\n  # BEGIN FLUX GATE TCP\n  - hostname: previous.example.com\n    service: tcp://127.0.0.1:15432\n  # END FLUX GATE TCP\n'));
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => queueMicrotask(() => callback(null)));
  await tunnel.apply();
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('FLUX GATE TCP'), false);
  assert.equal(text.split('BEGIN FLUX GATE ROUTES').length, 2);
  assert.ok(tunnel.status().rules.some((entry) => entry.hostname === 'previous.example.com' && entry.service === 'http_status:404'));
  config.routes[0].subdomain = 'renamed';
  await tunnel.apply();
  assert.ok(tunnel.status().rules.some((entry) => entry.hostname === 'db.example.com' && entry.service === 'http_status:404'));
  const stable = fs.readFileSync(file, 'utf8');
  t.mock.method(childProcess, 'execFile', () => { throw new Error('Applied no-op must not restart'); });
  assert.equal((await tunnel.apply()).status, 'applied'); assert.equal(fs.readFileSync(file, 'utf8'), stable);
});

test('simultaneous legacy/current blocks are rejected without replacing unmanaged configuration', async (t) => {
  const { original, file, tunnel } = fixture(t);
  const blocks = ['TCP', 'ROUTES'].map((name) => `  # BEGIN FLUX GATE ${name}\n  # END FLUX GATE ${name}\n`).join('');
  const text = original.replace('ingress:\n', 'ingress:\n' + blocks);
  fs.writeFileSync(file, text);
  await assert.rejects(tunnel.apply(), /Multiple managed/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('route edits during validation abort publication before replacing Tunnel configuration', async (t) => {
  const { original, file, config, tunnel } = fixture(t);
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    config.routes[0].port = 5433; queueMicrotask(() => callback(null));
  });
  await assert.rejects(tunnel.apply(), /Routes changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
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
