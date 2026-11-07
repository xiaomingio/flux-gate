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
const { once } = require('node:events');
const { createApp, hashPassword } = require('../src/server');
const Route = require('../src/Route');

async function fixture(t, routes = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-routes-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseDomain: 'example.com', auth: { username: 'admin', password_hash: hashPassword('secret') }, routes }));
  const app = createApp({ configFile }); await app.locals.ready;
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
  const request = async (method, url, body, headers = {}) => fetch(base + url, {
    method, headers: { Authorization: auth, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, server, configFile, request, base, auth };
}
async function save(request, route) {
  const response = await request('POST', '/api/routes', route);
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
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
