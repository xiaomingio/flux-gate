/*
 * 文件说明: 管理端持久会话、登录限流与 CSRF 校验；会话仅保存令牌摘要，并绑定当前凭据。
 * 对应文档: docs/admin-auth.md
 */
const crypto = require('node:crypto');
const fs = require('node:fs');

const DURATION = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'flux_gate_session';
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

class AdminAuth {
  constructor(store) {
    this.store = store;
    this.file = `${store.configFile}.flux-gate-sessions.json`;
    this.failures = new Map();
    try { this.sessions = JSON.parse(fs.readFileSync(this.file, 'utf8')).sessions; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Admin session store could not be read'); this.sessions = {}; }
    if (!this.sessions || typeof this.sessions !== 'object' || Array.isArray(this.sessions) || Object.entries(this.sessions).some(([id, session]) =>
      !/^[a-f0-9]{64}$/.test(id) || !session || typeof session.authenticated !== 'boolean' || !Number.isFinite(session.expires) ||
      !/^[a-f0-9]{64}$/.test(session.csrfToken) || !/^[a-f0-9]{64}$/.test(session.fingerprint))) throw new Error('Invalid admin session store');
  }
  fingerprint() { const auth = this.store.loadConfig().auth || {}; return digest(`${auth.username}\0${auth.password_hash}`); }
  save() {
    const now = Date.now();
    for (const [id, session] of Object.entries(this.sessions)) if (session.expires <= now) delete this.sessions[id];
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({ sessions: this.sessions }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  token(req) {
    const value = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    const token = value?.slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(token || '') ? token : null;
  }
  read(req) {
    const token = this.token(req), session = token && this.sessions[digest(token)];
    if (!session || session.expires <= Date.now() || session.fingerprint !== this.fingerprint()) return null;
    return session;
  }
  cookie(req, res, token, maxAge) {
    res.cookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge });
  }
  issue(req, res, authenticated) {
    this.remove(req);
    const token = crypto.randomBytes(32).toString('hex');
    const maxAge = authenticated ? DURATION : 10 * 60 * 1000;
    const session = { csrfToken: crypto.randomBytes(32).toString('hex'), authenticated, fingerprint: this.fingerprint(), expires: Date.now() + maxAge };
    for (const [id, value] of Object.entries(this.sessions)) if (value.expires <= Date.now()) delete this.sessions[id];
    const group = Object.keys(this.sessions).filter((id) => this.sessions[id].authenticated === authenticated);
    if (group.length >= (authenticated ? 1000 : 100)) {
      const oldest = group.sort((a, b) => this.sessions[a].expires - this.sessions[b].expires)[0]; delete this.sessions[oldest];
    }
    this.sessions[digest(token)] = session; this.save(); this.cookie(req, res, token, maxAge); return session;
  }
  remove(req) { const token = this.token(req); if (token) delete this.sessions[digest(token)]; }
  logout(req, res) { this.remove(req); this.save(); this.cookie(req, res, '', 0); }
  validWrite(req, session) {
    if (!session || !equal(req.get('X-CSRF-Token') || req.body?._csrf, session.csrfToken)) return false;
    if (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site'))) return false;
    if (req.get('origin')) {
      try { return new URL(req.get('origin')).origin === `${req.protocol}://${req.get('host')}`; } catch { return false; }
    }
    return true;
  }
  login(req) {
    const now = Date.now();
    for (const [key, entry] of this.failures) if (entry.until <= now) this.failures.delete(key);
    const key = req.ip;
    let entry = this.failures.get(key);
    if (entry?.count >= 10) return 'limited';
    const { username, password } = req.body || {}, auth = this.store.loadConfig().auth || {};
    if (typeof username === 'string' && typeof password === 'string' && auth.username && auth.password_hash && equal(username, auth.username) && equal(digest(password), auth.password_hash)) { this.failures.delete(key); return 'ok'; }
    if (!entry) { if (this.failures.size >= 1000) this.failures.delete(this.failures.keys().next().value); entry = { count: 0, until: now + 15 * 60 * 1000 }; this.failures.set(key, entry); }
    entry.count++; return 'invalid';
  }
  static next(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
    try { const url = new URL(value, 'http://admin.invalid'); if (url.origin !== 'http://admin.invalid' || ['/login', '/logout'].includes(url.pathname)) return '/'; return `${url.pathname}${url.search}`; } catch { return '/'; }
  }
}
module.exports = AdminAuth;
