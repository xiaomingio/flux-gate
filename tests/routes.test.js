/*
 * 文件说明: 验证 HTTP/TCP 目标契约、管理鉴权、密码保护代理与 WebSocket 升级。
 * 对应文档: docs/tcp-forwarding.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { once } = require('node:events');
const { createApp, hashPassword } = require('../src/server');
const Route = require('../src/Route');
const { login } = require('./AuthFixture.cjs');

async function fixture(t, routes = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-routes-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseDomain: 'example.com', auth: { username: 'admin', password_hash: hashPassword('secret') }, routes }));
  const app = createApp({ configFile }); await app.locals.ready;
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
  const sessionHeaders = await login(base);
  const request = async (method, url, body, headers = {}) => fetch(base + url, {
    method, headers: { ...sessionHeaders, Authorization: auth, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, server, configFile, request, base, auth, sessionHeaders };
}
async function save(request, route) {
  const response = await request('POST', '/api/routes', route);
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
}
async function enableTunnel(t, app, configFile) {
  const config = JSON.parse(fs.readFileSync(configFile));
  const file = path.join(path.dirname(configFile), 'native-tunnel.yml');
  fs.writeFileSync(file, 'tunnel: test\ningress:\n  - hostname: recovery.example.com\n    service: ssh://127.0.0.1:22\n  - hostname: "*.example.com"\n    service: http://127.0.0.1:8080\n  - service: http_status:404\n');
  config.tunnel = { enabled: true, config_file: file };
  fs.writeFileSync(configFile, JSON.stringify(config));
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => queueMicrotask(() => callback(null)));
  await app.locals.runtime.tunnel.apply();
  return file;
}

test('HTTP and TCP accept the same validated IPv4, IPv6 and hostname targets', async (t) => {
  const { request, configFile } = await fixture(t);
  for (const type of ['http', 'tcp']) {
    for (const ip of ['127.0.0.1', '::1', '[2001:db8::1]', 'service.internal']) {
      const result = await save(request, { type, subdomain: 'target', ip, port: 443 });
      const route = result.routes[0];
      assert.equal(route.target_service, new Route({ type, ip, port: 443 }).targetService);
      assert.equal(route.desired_path, type === 'tcp' ? 'direct' : 'gateway');
      assert.equal(route.publication_status, 'disabled');
    }
    const original = fs.readFileSync(configFile, 'utf8');
    for (const invalid of [{ ip: 'http://target' }, { ip: 'user@host' }, { ip: 'a/b' }, { ip: '127.0.0.999' }, { ip: '[host]' }, { ip: {} }, { port: '1e3' }, { port: 0 }, { port: 65536 }]) {
      const response = await request('POST', '/api/routes', { type, subdomain: 'target', ip: '127.0.0.1', port: 443, ...invalid });
      assert.equal(response.status, 400); assert.equal(fs.readFileSync(configFile, 'utf8'), original);
    }
  }
});

test('direct modes discard HTTP secrets and TCP rejects HTTP authentication', async (t) => {
  const { request, configFile } = await fixture(t);
  await save(request, { subdomain: 'web', ip: '127.0.0.1', port: 3000, username: 'alice', password: 'private' });
  await save(request, { subdomain: 'web', ip: '127.0.0.1', port: 3000, no_password: true });
  let route = JSON.parse(fs.readFileSync(configFile)).routes[0];
  assert.equal(route.username, undefined); assert.equal(route.password_hash, undefined);
  for (const auth of [{ username: 'alice' }, { password: 'private' }, { no_password: true }, { password_hash: 'private' }]) {
    const response = await request('POST', '/api/routes', { type: 'tcp', subdomain: 'web', ip: '127.0.0.1', port: 22, ...auth });
    assert.equal(response.status, 400);
  }
  await save(request, { type: 'tcp', subdomain: 'web', ip: '::1', port: 22 });
  route = JSON.parse(fs.readFileSync(configFile)).routes[0];
  assert.deepEqual(route, { type: 'tcp', subdomain: 'web', ip: '::1', port: 22, description: '', disabled: false });
  for (const method of ['GET', 'DELETE']) {
    const response = await request(method, method === 'GET' ? '/api/routes' : '/api/routes/absent');
    assert.ok(!(await response.text()).includes('password_hash'));
  }
});

test('custom authentication requires both credentials on each full save while toggle preserves the saved hash', async (t) => {
  const { request, configFile } = await fixture(t);
  const route = { subdomain: 'custom', ip: '127.0.0.1', port: 3000, auth_mode: 'custom', username: 'alice', password: 'first-secret' };
  await save(request, route);
  const original = fs.readFileSync(configFile, 'utf8');
  for (const credentials of [{ username: '', password: '' }, { username: 'alice', password: '' }, { username: '', password: 'secret' }, { username: '  ', password: '  ' }]) {
    assert.equal((await request('POST', '/api/routes', { ...route, ...credentials })).status, 400);
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  }
  assert.equal((await request('PATCH', '/api/routes/custom', { disabled: true })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).routes[0].password_hash, hashPassword('first-secret'));
  assert.equal((await request('POST', '/api/routes', { ...route, no_password: true })).status, 400);
  await save(request, { ...route, username: ' alice ', password: ' second-secret ' });
  assert.equal(JSON.parse(fs.readFileSync(configFile)).routes[0].password_hash, hashPassword('second-secret'));
  const receipts = fs.readFileSync(configFile + '.flux-gate-operations.json', 'utf8');
  for (const secret of ['first-secret', 'second-secret', hashPassword('second-secret'), 'password_hash']) assert.equal(receipts.includes(secret), false);
  await save(request, { subdomain: 'custom', ip: '127.0.0.1', port: 3000, auth_mode: 'default' });
  const saved = JSON.parse(fs.readFileSync(configFile)).routes[0];
  assert.equal(saved.password_hash, undefined); assert.equal(saved.username, undefined);
});

test('only password-protected HTTP routes proxy requests and preserve target Host/body', async (t) => {
  const backend = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.end(JSON.stringify({ host: req.headers.host, body: Buffer.concat(chunks).toString() }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  const port = backend.address().port;
  const { request } = await fixture(t, [
    { subdomain: 'protected', ip: '127.0.0.1', port },
    { subdomain: 'direct', ip: '127.0.0.1', port, no_password: true },
    { subdomain: 'tcp', type: 'tcp', ip: '127.0.0.1', port },
  ]);
  const unauthorized = await request('GET', '/', undefined, { 'x-forwarded-host': 'protected.example.com', Authorization: '' });
  assert.equal(unauthorized.status, 401);
  const result = await request('POST', '/', { payload: 'forwarded' }, { 'x-forwarded-host': 'protected.example.com' });
  assert.deepEqual(await result.json(), { host: `127.0.0.1:${port}`, body: '{"payload":"forwarded"}' });
  for (const name of ['direct', 'tcp']) assert.equal((await request('GET', '/', undefined, { 'x-forwarded-host': `${name}.example.com` })).status, 404);
});

test('protected HTTP WebSocket upgrade enforces credentials and reaches target', async (t) => {
  const sockets = new Set();
  const backend = http.createServer();
  backend.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.write(`target-host=${req.headers.host}`);
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => backend.close(resolve)); });
  const port = backend.address().port;
  const { server, auth } = await fixture(t, [{ subdomain: 'ws', ip: '127.0.0.1', port }]);
  for (const authorized of [false, true]) {
    const socket = net.connect(server.address().port, '127.0.0.1');
    await once(socket, 'connect'); const chunks = [];
    socket.on('data', (chunk) => { chunks.push(chunk); if (Buffer.concat(chunks).includes('target-host=')) socket.destroy(); });
    const closed = once(socket, 'close');
    socket.write(`GET /socket HTTP/1.1\r\nHost: ws.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${authorized ? `Authorization: ${auth}\r\n` : ''}\r\n`);
    await closed;
    assert.equal(Buffer.concat(chunks).includes(`target-host=127.0.0.1:${port}`), authorized);
  }
});

test('write protection and atomic persistence failures preserve saved routes', async (t) => {
  const { request, base, configFile } = await fixture(t);
  assert.equal((await request('DELETE', '/api/routes/web', undefined, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('POST', '/api/tunnel/apply')).status, 403);
  assert.equal((await request('POST', '/api/tunnel/apply', undefined, { Origin: base })).status, 409);
  const original = fs.readFileSync(configFile, 'utf8'), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === configFile) throw Object.assign(new Error('Simulated disk write failure'), { code: 'EIO' });
    return rename(source, destination);
  });
  assert.equal((await request('POST', '/api/routes', { type: 'tcp', subdomain: 'db', ip: '127.0.0.1', port: 5432 })).status, 500);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
});

test('malformed configuration fails closed instead of enabling default credentials', async (t) => {
  const { configFile } = await fixture(t);
  fs.writeFileSync(configFile, '{invalid JSON');
  const invalid = createApp({ configFile });
  await assert.rejects(invalid.locals.ready, /could not be read or parsed/);
});

test('Tunnel API inventories all file rules without exposing secrets or taking ownership', async (t) => {
  const { request, configFile } = await fixture(t, [{ subdomain: 'managed', ip: '127.0.0.1', port: 3000, no_password: true }]);
  const file = path.join(path.dirname(configFile), 'tunnel.yml');
  const original = 'tunnel: SECRET-TUNNEL-ID\ntoken: SECRET-TOKEN\ncredentials-file: /private/SECRET-CREDENTIAL.json\ningress:\n' +
    '  # BEGIN FLUX GATE ROUTES\n  - hostname: managed.example.com\n    service: http://127.0.0.1:3000\n    originRequest:\n      httpHostHeader: 127.0.0.1:3000\n      httpHeaders:\n        Authorization: SECRET-HEADER\n  # END FLUX GATE ROUTES\n' +
    '  - hostname: recovery.example.com\n    service: ssh://user:SECRET-PASSWORD@127.0.0.1:22?token=SECRET-QUERY\n' +
    '  - hostname: example.com\n    service: http://127.0.0.1:8080\n' +
    '  - hostname: "*.example.com"\n    path: /special/.*\n    service: http://127.0.0.1:3001\n' +
    '  - hostname: "*.example.com"\n    service: http://127.0.0.1:8080\n  - service: http_status:404\n';
  fs.writeFileSync(file, original);
  fs.writeFileSync(`${file}.flux-gate-applied.json`, JSON.stringify({ sha256: crypto.createHash('sha256').update(original).digest('hex') }));
  const config = JSON.parse(fs.readFileSync(configFile)); config.tunnel = { enabled: true, config_file: file };
  fs.writeFileSync(configFile, JSON.stringify(config));
  let response = await request('GET', '/api/tunnel');
  let text = await response.text(), result = JSON.parse(text);
  assert.equal(response.status, 200); assert.equal(result.current_verified, true);
  assert.equal(result.existing_rules.length, 6);
  assert.deepEqual(result.existing_rules[0], { hostname: 'managed.example.com', path: null, service: 'http://127.0.0.1:3000', managed: true });
  assert.deepEqual(result.existing_rules[1], { hostname: 'recovery.example.com', path: null, service: 'ssh://127.0.0.1:22', managed: false });
  assert.equal(result.existing_rules[3].path, '/special/.*');
  assert.equal(result.existing_rules.at(-1).hostname, null);
  assert.ok(!text.includes('SECRET-')); assert.ok(!text.includes('httpHeaders')); assert.ok(!text.includes('credentials-file'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  config.tunnel.enabled = false; fs.writeFileSync(configFile, JSON.stringify(config));
  result = await (await request('GET', '/api/tunnel')).json();
  assert.equal(result.status, 'disabled'); assert.equal(result.existing_rules.length, 6);
  config.tunnel.enabled = true; config.routes[0].subdomain = 'recovery'; fs.writeFileSync(configFile, JSON.stringify(config));
  result = await (await request('GET', '/api/tunnel')).json();
  assert.equal(result.status, 'error'); assert.equal(result.existing_rules.length, 6);
  fs.writeFileSync(file, 'token: SECRET-TOKEN\ningress: [ invalid: SECRET-PARSER-SNIPPET');
  text = await (await request('GET', '/api/tunnel')).text();
  assert.ok(!text.includes('SECRET-')); assert.ok(JSON.parse(text).existing_rules_error);
});

test('save, pause, resume and delete are confirmed only after native Tunnel synchronization', async (t) => {
  const { app, request, configFile } = await fixture(t);
  const file = await enableTunnel(t, app, configFile);
  const id = crypto.randomUUID();
  let response = await request('POST', '/api/routes', { type: 'tcp', subdomain: 'db', ip: '::1', port: 5432 }, { 'X-Flux-Gate-Operation': id });
  let result = await response.json();
  assert.equal(result.operation.id, id); assert.equal(result.operation.status, 'applied'); assert.equal(result.operation.current, true);
  assert.equal(result.routes[0].publication_status, 'applied'); assert.equal(result.routes[0].current_service, 'tcp://[::1]:5432');
  result = await (await request('PATCH', '/api/routes/db', { disabled: true })).json();
  assert.equal(result.operation.status, 'applied'); assert.equal(result.routes.length, 1); assert.equal(result.routes[0].current_path, 'blocked');
  result = await (await request('PATCH', '/api/routes/db', { disabled: false })).json();
  assert.equal(result.routes[0].current_service, 'tcp://[::1]:5432');
  result = await (await request('DELETE', '/api/routes/db')).json();
  assert.equal(result.operation.status, 'applied'); assert.equal(result.routes.length, 0);
  assert.ok(fs.readFileSync(file, 'utf8').includes('http_status:404'));
  const stale = await (await request('GET', '/api/operations/' + id)).json();
  assert.equal(stale.operation.current, false);
});

test('failed automatic validation or restart restores previous config and confirmed Tunnel routing', async (t) => {
  const { app, request, configFile } = await fixture(t);
  const file = await enableTunnel(t, app, configFile);
  const originalConfig = JSON.parse(fs.readFileSync(configFile)), originalTunnel = fs.readFileSync(file, 'utf8');
  for (const failure of ['cloudflared', 'pm2']) {
    let failed = false;
    t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
      const fail = command === failure && !failed; if (fail) failed = true;
      queueMicrotask(() => callback(fail ? new Error('Simulated native command failure') : null));
    });
    const response = await request('POST', '/api/routes', { type: 'tcp', subdomain: 'failed', ip: '127.0.0.1', port: 22 });
    const result = await response.json();
    assert.equal(response.status, 500); assert.equal(result.operation.status, 'rolled_back'); assert.equal(result.operation.rollback_confirmed, true);
    assert.equal(result.operation.current, true); assert.equal(result.tunnel.status, 'applied');
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), originalConfig);
    assert.equal(fs.readFileSync(file, 'utf8'), originalTunnel);
  }
});

test('external publish lock rejects a mutation before changing saved configuration', async (t) => {
  const { app, request, configFile } = await fixture(t);
  const file = await enableTunnel(t, app, configFile), original = fs.readFileSync(configFile, 'utf8');
  fs.writeFileSync(file + '.flux-gate.lock', 'external publisher');
  const response = await request('POST', '/api/routes', { type: 'tcp', subdomain: 'blocked', ip: '127.0.0.1', port: 22 });
  assert.equal(response.status, 409); assert.equal((await response.json()).operation.status, 'error');
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
});

test('unconfirmed recovery is never offered as a safe retry', async (t) => {
  const { app, request, configFile } = await fixture(t);
  await enableTunnel(t, app, configFile);
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => queueMicrotask(() => callback(command === 'pm2' ? new Error('Restart and recovery unavailable') : null)));
  const response = await request('POST', '/api/routes', { type: 'tcp', subdomain: 'failed', ip: '127.0.0.1', port: 22 });
  const result = await response.json();
  assert.equal(response.status, 500); assert.equal(result.operation.status, 'error');
  assert.equal(result.operation.rollback_confirmed, false); assert.equal(result.operation.current, false);
  assert.equal(result.tunnel.current_verified, false);
});

test('automatic publications serialize queued mutations across config save and native restart', async (t) => {
  const { app, request, configFile } = await fixture(t);
  await enableTunnel(t, app, configFile);
  let resume, reached, paused = false;
  const restarting = new Promise(resolve => { reached = resolve; });
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    if (command === 'pm2' && !paused) { paused = true; resume = callback; reached(); }
    else queueMicrotask(() => callback(null));
  });
  const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
  const first = request('POST', '/api/routes', { type: 'tcp', subdomain: 'first', ip: '127.0.0.1', port: 22 }, { 'X-Flux-Gate-Operation': firstId });
  await restarting;
  const second = request('POST', '/api/routes', { type: 'tcp', subdomain: 'second', ip: '127.0.0.1', port: 23 }, { 'X-Flux-Gate-Operation': secondId });
  let queued;
  for (let attempt = 0; attempt < 20; attempt++) {
    queued = (await (await request('GET', '/api/operations/' + secondId)).json()).operation;
    if (queued) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(queued.status, 'queued');
  assert.equal(app.locals.runtime.operation(firstId).status, 'running');
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)).routes.map(route => route.subdomain), ['first']);
  resume(null);
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)).routes.map(route => route.subdomain), ['first', 'second']);
  assert.equal(app.locals.runtime.operation(secondId).current, true);
});

test('a disconnected write completes once and its persistent receipt confirms password-only changes', async (t) => {
  const { app, request, server, configFile, sessionHeaders } = await fixture(t);
  await enableTunnel(t, app, configFile);
  const route = { subdomain: 'web', ip: '127.0.0.1', port: 3000, auth_mode: 'custom', username: 'user', password: 'first-secret' };
  await save(request, route);
  const id = crypto.randomUUID();
  let reached;
  const restarting = new Promise(resolve => { reached = resolve; });
  // Only a password changes, so Tunnel is already applied and should not restart.
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    const result = rename(source, target);
    if (target === configFile) reached();
    return result;
  });
  const payload = JSON.stringify({ ...route, password: 'second-secret' });
  const write = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/routes', method: 'POST', headers: { ...sessionHeaders, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Flux-Gate-Operation': id } });
  write.on('error', () => {}); write.end(payload);
  await restarting; write.destroy();
  let operation;
  for (let attempt = 0; attempt < 20; attempt++) {
    operation = (await (await request('GET', '/api/operations/' + id)).json()).operation;
    if (operation && !['queued', 'running'].includes(operation.status)) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(operation.status, 'applied'); assert.equal(operation.current, true);
  assert.ok(!JSON.stringify(operation).includes('secret')); assert.ok(!JSON.stringify(operation).includes('sha256'));
  const repeat = await request('POST', '/api/routes', { ...route, password: 'third-secret' }, { 'X-Flux-Gate-Operation': id });
  assert.equal(repeat.status, 409);
  assert.equal(JSON.parse(fs.readFileSync(configFile)).routes[0].password_hash, hashPassword('second-secret'));
  const next = createApp({ configFile }); await next.locals.ready;
  assert.equal(next.locals.runtime.operation(id).status, 'applied'); assert.equal(next.locals.runtime.operation(id).current, true);
});

test('interrupted startup receipts become unknown without replaying writes and disabled saves remain local', async (t) => {
  const { app, request, configFile } = await fixture(t);
  const result = await save(request, { type: 'tcp', subdomain: 'local', ip: '127.0.0.1', port: 22 });
  assert.equal(result.operation.status, 'local_only'); assert.equal(result.operation.current, true);
  const tunnelFile = await enableTunnel(t, app, configFile);
  const file = configFile + '.flux-gate-operations.json', saved = JSON.parse(fs.readFileSync(file));
  const id = crypto.randomUUID(); saved.operations.push({ id, revision: crypto.randomUUID(), status: 'running' });
  fs.writeFileSync(file, JSON.stringify(saved));
  const configBefore = fs.readFileSync(configFile, 'utf8'), tunnelBefore = fs.readFileSync(tunnelFile, 'utf8');
  t.mock.method(childProcess, 'execFile', () => { throw new Error('Interrupted operations must not be replayed at startup'); });
  const next = createApp({ configFile }); await next.locals.ready;
  assert.equal(next.locals.runtime.operation(id).status, 'unknown'); assert.equal(next.locals.runtime.operation(id).current, false);
  assert.equal(fs.readFileSync(configFile, 'utf8'), configBefore); assert.equal(fs.readFileSync(tunnelFile, 'utf8'), tunnelBefore);
});
