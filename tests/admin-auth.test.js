/*
 * 文件说明: 通过真实 HTTP 验证管理会话生命周期、写入保护与转发鉴权边界。
 * 对应文档: docs/admin-auth.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp, hashPassword } = require('../src/server');
const { login } = require('./AuthFixture.cjs');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-auth-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseDomain: 'example.com', auth: { username: 'admin', password_hash: hashPassword('secret:colon') }, routes: [{ subdomain: 'protected', ip: '127.0.0.1', port: 65535 }] }));
  const servers = [];
  const start = async () => {
    const app = createApp({ configFile }); await app.locals.ready;
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const base = await start();
  t.after(async () => { for (const server of servers) await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { base, configFile, start };
}
async function anonymous(base, headers = {}) {
  const page = await fetch(base + '/login', { headers });
  const html = await page.text();
  return { cookie: page.headers.getSetCookie().find((value) => value.startsWith('flux_gate_session=')), csrf: html.match(/name="_csrf"\s+value="([a-f0-9]+)"/)[1] };
}
function submit(base, session, extra = {}, headers = {}) {
  return fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { Cookie: session.cookie.split(';')[0], 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username: 'admin', password: 'secret:colon', _csrf: session.csrf, ...extra }) });
}

test('admin requires a session while proxy requires Basic credentials independently', async (t) => {
  const { base } = await fixture(t);
  const basic = `Basic ${Buffer.from('admin:secret:colon').toString('base64')}`;
  const page = await fetch(base + '/settings?lang=en', { headers: { Authorization: basic }, redirect: 'manual' });
  assert.equal(page.status, 303); assert.equal(page.headers.get('location'), '/login?next=%2Fsettings%3Flang%3Den');
  const api = await fetch(base + '/api/routes', { headers: { Authorization: basic } });
  assert.equal(api.status, 401); assert.equal(api.headers.get('www-authenticate'), null);
  const expiredWrite = await fetch(base + '/settings/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(expiredWrite.status, 401); assert.equal((await expiredWrite.json()).error, 'Admin login required');
  const expiredForm = await fetch(base + '/settings/password', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '', redirect: 'manual' });
  assert.equal(expiredForm.status, 303); assert.match(expiredForm.headers.get('location'), /^\/login\?/);
  const headers = await login(base, 'secret:colon');
  const proxy = await fetch(base + '/', { headers: { ...headers, 'x-forwarded-host': 'protected.example.com' } });
  assert.equal(proxy.status, 401); assert.ok(proxy.headers.get('www-authenticate'));
  const basicProxy = await fetch(base + '/', { headers: { Authorization: basic, 'x-forwarded-host': 'protected.example.com' } });
  assert.equal(basicProxy.status, 502);
  const session = await fetch(base + '/api/session', { headers });
  assert.equal(session.status, 200); assert.match(session.headers.get('cache-control'), /no-store/); assert.match(session.headers.get('x-robots-tag'), /noindex/);
});

test('login rotates tokens, rejects external next and protects all writes including logout', async (t) => {
  const { base } = await fixture(t), anon = await anonymous(base);
  assert.equal((await submit(base, anon, {}, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await submit(base, anon, { _csrf: 'wrong' })).status, 403);
  const response = await submit(base, anon, { next: '//attacker.example' });
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/');
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('flux_gate_session='));
  assert.notEqual(cookie.split(';')[0], anon.cookie.split(';')[0]);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Path=\//); assert.match(cookie, /Max-Age=2592000/); assert.doesNotMatch(cookie, /; Secure/);
  assert.equal((await fetch(base + '/api/session', { headers: { Cookie: anon.cookie.split(';')[0] } })).status, 401);
  const headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await fetch(base + '/api/routes/none', { method: 'DELETE', headers })).status, 403);
  const session = await (await fetch(base + '/api/session', { headers })).json(); headers['X-CSRF-Token'] = session.csrfToken;
  assert.equal((await fetch(base + '/logout', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, redirect: 'manual' })).status, 403);
  const logout = await fetch(base + '/logout', { method: 'POST', headers, redirect: 'manual' });
  assert.equal(logout.status, 303); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(base + '/api/session', { headers })).status, 401);
});

test('sessions persist for 30 days across restart, exclude raw tokens and expire on credential changes', async (t) => {
  const { base, configFile, start } = await fixture(t);
  const now = Date.now();
  const headers = await login(base, 'secret:colon');
  const contents = fs.readFileSync(configFile + '.flux-gate-sessions.json', 'utf8');
  assert.equal(fs.statSync(configFile + '.flux-gate-sessions.json').mode & 0o777, 0o600);
  assert.equal(contents.includes(headers.Cookie.split('=')[1]), false); assert.equal(contents.includes('secret:colon'), false); assert.equal(contents.includes(hashPassword('secret:colon')), false);
  const second = await start();
  assert.equal((await fetch(second + '/api/session', { headers })).status, 200);
  t.mock.method(Date, 'now', () => now + 29 * 24 * 60 * 60 * 1000);
  assert.equal((await fetch(second + '/api/session', { headers })).status, 200);
  t.mock.method(Date, 'now', () => now + 31 * 24 * 60 * 60 * 1000);
  assert.equal((await fetch(second + '/api/session', { headers })).status, 401);
  t.mock.restoreAll();
  const config = JSON.parse(fs.readFileSync(configFile)); config.auth.username = 'changed'; fs.writeFileSync(configFile, JSON.stringify(config));
  assert.equal((await fetch(second + '/api/session', { headers })).status, 401);
});

test('password changes require CSRF and revoke all current sessions', async (t) => {
  const { base, configFile } = await fixture(t);
  const first = await login(base, 'secret:colon'), second = await login(base, 'secret:colon');
  const request = (headers) => fetch(base + '/settings/password', { method: 'POST', redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ current: 'secret:colon', new_pass: 'new-secret', confirm: 'new-secret' }) });
  assert.equal((await request({ Cookie: first.Cookie })).status, 403);
  const invalid = await fetch(base + '/settings/password', { method: 'POST', headers: { ...first, 'Content-Type': 'application/json' }, body: JSON.stringify({ current: 'wrong', new_pass: 'new-secret', confirm: 'new-secret' }) });
  assert.equal(invalid.status, 400); assert.ok((await invalid.json()).error);
  assert.equal((await fetch(base + '/api/session', { headers: first })).status, 200);
  const updated = await request(first); assert.equal(updated.status, 200); assert.deepEqual(await updated.json(), { ok: true, redirect: '/login' });
  assert.equal(JSON.parse(fs.readFileSync(configFile)).auth.password_hash, hashPassword('new-secret'));
  for (const headers of [first, second]) assert.equal((await fetch(base + '/api/session', { headers })).status, 401);
  assert.ok(await login(base, 'new-secret'));
});

test('login throttles repeated failures and HTTPS via trusted loopback sets Secure', async (t) => {
  const { base } = await fixture(t);
  const anon = await anonymous(base, { 'x-forwarded-proto': 'https' }); assert.match(anon.cookie, /; Secure/);
  const valid = await submit(base, anon, {}, { 'x-forwarded-proto': 'https', Origin: base.replace('http:', 'https:') });
  assert.equal(valid.status, 303); assert.match(valid.headers.get('set-cookie'), /; Secure/);
  const failure = await anonymous(base);
  for (let i = 0; i < 10; i++) assert.equal((await submit(base, failure, { password: 'wrong' })).status, 401);
  const limited = await submit(base, failure); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '900');
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 16 * 60 * 1000);
  const fresh = await anonymous(base); assert.equal((await submit(base, fresh)).status, 303);
});

test('anonymous login visits cannot evict authenticated sessions and corrupt storage fails closed', async (t) => {
  const { base, configFile } = await fixture(t), headers = await login(base, 'secret:colon');
  for (let i = 0; i < 105; i++) {
    const page = await fetch(base + '/login'); assert.equal(page.status, 200); await page.arrayBuffer();
  }
  assert.equal((await fetch(base + '/api/session', { headers })).status, 200);
  fs.writeFileSync(configFile + '.flux-gate-sessions.json', JSON.stringify({ sessions: { broken: null } }));
  assert.throws(() => createApp({ configFile }), /Invalid admin session store/);
});
