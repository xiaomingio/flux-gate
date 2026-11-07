/*
 * 文件说明: 通过真实登录表单取得管理会话，为 HTTP 行为测试提供认证请求头。
 */
const assert = require('node:assert/strict');
async function login(base, password = 'secret', headers = {}) {
  const page = await fetch(base + '/login', { headers, redirect: 'manual' });
  const html = await page.text();
  const csrfToken = html.match(/name="_csrf"\s+value="([a-f0-9]+)"/)?.[1];
  assert.ok(csrfToken, html);
  const anonymous = page.headers.getSetCookie().find((cookie) => cookie.startsWith('flux_gate_session='))?.split(';')[0];
  const response = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { Cookie: anonymous, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username: 'admin', password, _csrf: csrfToken }) });
  assert.equal(response.status, 303, await response.text());
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('flux_gate_session='))?.split(';')[0];
  const session = await fetch(base + '/api/session', { headers: { Cookie: cookie, ...headers } });
  const data = await session.json();
  return { Cookie: cookie, 'X-CSRF-Token': data.csrfToken };
}
module.exports = { login };
