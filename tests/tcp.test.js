/*
 * 文件说明: 通过真实管理 API 和 TCP socket 验证路由事务、字节流、半关闭和连接清理。
 * 对应文档: docs/tcp-forwarding.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createApp, hashPassword } = require('../src/server');

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
async function freePort() {
  const server = net.createServer(); const port = await listen(server);
  await new Promise((resolve) => server.close(resolve)); return port;
}
function closed(client) {
  client.on('error', () => {});
  return new Promise((resolve) => client.once('close', resolve));
}
async function socket(port) {
  const client = net.connect(port, '127.0.0.1'); await once(client, 'connect'); return client;
}
async function fixture(t, routes = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-tcp-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseDomain: 'example.com', auth: { username: 'admin', password_hash: hashPassword('secret') }, routes }));
  const app = createApp({ configFile }); await app.locals.ready;
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, url, body, headers = {}) => fetch(base + url, {
    method, headers: { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, server, configFile, request, base };
}
function target(t, handle) {
  const connections = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    connections.add(connection); connection.on('error', () => {}); connection.once('close', () => connections.delete(connection)); handle(connection);
  });
  t.after(async () => { for (const connection of connections) connection.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return server;
}
async function save(request, route) {
  const response = await request('POST', '/api/routes', route);
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
}

test('TCP API forwards large binary payload and response after half-close', { timeout: 10_000 }, async (t) => {
  const backend = target(t, (connection) => {
    const hash = crypto.createHash('sha256');
    connection.on('data', (chunk) => { connection.pause(); hash.update(chunk); setImmediate(() => connection.resume()); });
    connection.on('end', () => connection.end(hash.digest()));
  });
  const targetPort = await listen(backend), listenPort = await freePort();
  const { request } = await fixture(t);
  const result = await save(request, { type: 'tcp', subdomain: 'tcp', ip: '127.0.0.1', port: targetPort, listen_port: listenPort });
  assert.equal(result.routes[0].listener_status, 'listening');
  const client = await socket(listenPort); t.after(() => client.destroy());
  const received = []; client.on('data', (chunk) => received.push(chunk));
  const ended = once(client, 'end');
  const data = crypto.randomBytes(8 * 1024 * 1024); client.end(data);
  await ended;
  assert.deepEqual(Buffer.concat(received), crypto.createHash('sha256').update(data).digest());
});

test('target half-close keeps reverse direction writable', { timeout: 10_000 }, async (t) => {
  let finish; const finished = new Promise((resolve) => { finish = resolve; });
  const backend = target(t, (connection) => {
    connection.end('banner'); const chunks = [];
    connection.on('data', (data) => chunks.push(data)); connection.on('end', () => finish(Buffer.concat(chunks).toString()));
  });
  const port = await listen(backend), listenPort = await freePort();
  const { request } = await fixture(t);
  await save(request, { type: 'tcp', subdomain: 'tcp', ip: '127.0.0.1', port, listen_port: listenPort });
  const client = net.connect({ port: listenPort, host: '127.0.0.1', allowHalfOpen: true });
  const chunks = []; client.on('data', (data) => chunks.push(data));
  await once(client, 'end'); assert.equal(Buffer.concat(chunks).toString(), 'banner');
  client.end('after-banner'); assert.equal(await finished, 'after-banner');
});

test('bind conflicts and validation failures preserve exact saved configuration and existing listener', { timeout: 10_000 }, async (t) => {
  const backend = target(t, (connection) => connection.pipe(connection));
  const port = await listen(backend), listenPort = await freePort();
  const { request, configFile } = await fixture(t);
  await save(request, { type: 'tcp', subdomain: 'tcp', ip: '127.0.0.1', port, listen_port: listenPort });
  const original = fs.readFileSync(configFile, 'utf8');
  for (const invalid of [
    { listen_port: port }, { listen_port: listenPort, username: 'bad' }, { listen_port: 22 },
    { listen_port: listenPort, port: listenPort }, { listen_port: listenPort, type: 'udp' },
  ]) {
    const response = await request('POST', '/api/routes', { type: 'tcp', subdomain: 'tcp', ip: '127.0.0.1', port, listen_port: listenPort, ...invalid });
    assert.ok([400, 409].includes(response.status)); assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  }
  const client = await socket(listenPort); t.after(() => client.destroy());
  const echoed = once(client, 'data'); client.write('still-live'); assert.equal((await echoed)[0].toString(), 'still-live');
});

test('disable, enable, target edit, delete and server close own every TCP connection', { timeout: 10_000 }, async (t) => {
  const backend = target(t, (connection) => connection.pipe(connection));
  const port = await listen(backend), listenPort = await freePort();
  const { request, app } = await fixture(t);
  const route = { type: 'tcp', subdomain: 'tcp', ip: '127.0.0.1', port, listen_port: listenPort };
  await save(request, route);
  const first = await socket(listenPort); const firstClosed = closed(first);
  assert.equal((await request('PATCH', '/api/routes/tcp', { disabled: true })).status, 200); await firstClosed;
  assert.equal(app.locals.runtime.tcp.totalConnections, 0);
  await assert.rejects(socket(listenPort));
  assert.equal((await request('PATCH', '/api/routes/tcp', { disabled: false })).status, 200);
  const second = await socket(listenPort); const secondClosed = closed(second);
  await save(request, { ...route, subdomain: 'renamed', original_subdomain: 'tcp' }); await secondClosed;
  const third = await socket(listenPort); const thirdClosed = closed(third);
  assert.equal((await request('DELETE', '/api/routes/renamed')).status, 200); await thirdClosed;
  assert.equal(app.locals.runtime.tcp.totalConnections, 0);
  await save(request, route);
  const fourth = await socket(listenPort), fourthClosed = closed(fourth);
  app.locals.runtime.close(); await fourthClosed;
  await assert.rejects(socket(listenPort));
});

test('target refusal reclaims connections and startup recreates saved listeners', { timeout: 10_000 }, async (t) => {
  const port = await freePort(), listenPort = await freePort();
  const { request, app, configFile } = await fixture(t);
  await save(request, { type: 'tcp', subdomain: 'tcp', ip: '127.0.0.1', port, listen_port: listenPort });
  const client = await socket(listenPort); await closed(client);
  assert.equal(app.locals.runtime.tcp.totalConnections, 0);
  app.locals.runtime.close();
  const next = createApp({ configFile }); await next.locals.ready;
  assert.equal(next.locals.runtime.tcp.status(JSON.parse(fs.readFileSync(configFile)).routes[0]), 'listening');
  next.locals.runtime.close();
});

test('API never exposes password hashes and rejects hostile Origin writes', async (t) => {
  const { request, base } = await fixture(t, [{ subdomain: 'web', ip: '127.0.0.1', port: 1, username: 'user', password_hash: hashPassword('private') }]);
  for (const method of ['GET', 'DELETE']) {
    const response = await request(method, method === 'GET' ? '/api/routes' : '/api/routes/absent');
    const body = await response.text(); assert.ok(!body.includes('password_hash')); assert.ok(!body.includes(hashPassword('private')));
  }
  assert.equal((await request('DELETE', '/api/routes/web', undefined, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request('POST', '/api/tunnel/apply')).status, 403);
  assert.equal((await request('POST', '/api/tunnel/apply', undefined, { Origin: base })).status, 409);
});

test('config persistence failure releases staged TCP listener and preserves original bytes', async (t) => {
  const port = await freePort(), listenPort = await freePort();
  const { request, configFile } = await fixture(t);
  const original = fs.readFileSync(configFile, 'utf8');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === configFile) throw Object.assign(new Error('Simulated disk write failure'), { code: 'EIO' });
    return rename(source, destination);
  });
  const response = await request('POST', '/api/routes', { type: 'tcp', subdomain: 'failed', ip: '127.0.0.1', port, listen_port: listenPort });
  assert.equal(response.status, 500); assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  await assert.rejects(socket(listenPort));
});

test('pending target timeout destroys both sockets and reclaims capacity', async (t) => {
  const listenPort = await freePort();
  const { request, app } = await fixture(t);
  await save(request, { type: 'tcp', subdomain: 'timeout', ip: '127.0.0.1', port: 1, listen_port: listenPort });
  const pending = new net.Socket({ allowHalfOpen: true });
  let accept; const accepted = new Promise((resolve) => { accept = resolve; });
  t.mock.method(net, 'connect', () => { accept(); return pending; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new net.Socket(); client.connect(listenPort, '127.0.0.1'); await once(client, 'connect');
  const ended = closed(client);
  await accepted;
  assert.equal(app.locals.runtime.tcp.totalConnections, 1);
  t.mock.timers.tick(10_000);
  await ended;
  assert.equal(pending.destroyed, true); assert.equal(app.locals.runtime.tcp.totalConnections, 0);
});

test('startup bind conflict releases earlier listeners and malformed config never enables default credentials', async (t) => {
  const backend = target(t, (connection) => connection.destroy());
  const occupied = await listen(backend), staged = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ routes: [
    { type: 'tcp', subdomain: 'first', listen_port: staged, ip: '127.0.0.1', port: 1 },
    { type: 'tcp', subdomain: 'conflict', listen_port: occupied, ip: '127.0.0.1', port: 1 },
  ] }));
  const app = createApp({ configFile });
  await assert.rejects(app.locals.ready, { code: 'EADDRINUSE' });
  app.locals.runtime.close();
  await assert.rejects(socket(staged));
  fs.writeFileSync(configFile, '{invalid JSON');
  const invalid = createApp({ configFile });
  await assert.rejects(invalid.locals.ready, /could not be read or parsed/);
  invalid.locals.runtime.close();
});
