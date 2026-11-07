/*
 * 文件说明: 提供 flux-gate 的子域名反向代理与管理界面入口，代理请求不经过 body parser 直接转发给后端。
 * 参考资料: config.sample.json
 */
const express = require('express');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RouteConfig = require('./RouteConfig');
const Route = require('./Route');
const TunnelConfig = require('./TunnelConfig');

const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const LOCALES_DIR = path.join(__dirname, 'locales');
const SUPPORTED_LANG_CODES = ['zh', 'en'];
const SUPPORTED_LANGS = new Set(SUPPORTED_LANG_CODES);

function loadTranslations() {
  return Object.fromEntries(
    SUPPORTED_LANG_CODES.map((lang) => {
      const localePath = path.join(LOCALES_DIR, `${lang}.json`);
      return [lang, JSON.parse(fs.readFileSync(localePath, 'utf8'))];
    })
  );
}

const translations = loadTranslations();

function createConfigStore(configFile = DEFAULT_CONFIG_FILE) {
  function loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Gateway configuration could not be read or parsed');
      return {
        port: 8080,
        baseDomain: 'localhost',
        auth: { username: 'admin', password_hash: '' },
        routes: [],
      };
    }
  }

  function saveConfig(cfg) {
    const temporary = `${configFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(cfg, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, configFile);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  return { loadConfig, saveConfig, configFile };
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 1 || value === 'on';
}

function sanitizeRoute(route, config, tunnelStatus) {
  const model = new Route(route);
  const desired = model.rule(config);
  const current = tunnelStatus.changes.find((change) => change.hostname === desired.hostname);
  return {
    type: model.isTcp ? 'tcp' : 'http',
    subdomain: route.subdomain,
    ip: route.ip,
    port: route.port,
    description: route.description || '',
    disabled: Boolean(route.disabled),
    ...(!model.isTcp && { username: route.username || '', no_password: Boolean(route.no_password), has_custom_auth: Boolean(route.username || route.password_hash) }),
    hostname: desired.hostname, target_service: model.targetService, tunnel_service: desired.service,
    desired_path: model.path, current_path: current?.current_path || 'unknown',
    current_service: current?.current_service || null, current_verified: tunnelStatus.current_verified,
    publication_status: ['disabled', 'error'].includes(tunnelStatus.status) ? tunnelStatus.status : current?.status || 'pending',
  };
}

function getRouteEffectiveAuth(route, config) {
  return {
    username: route.username || config.auth.username,
    passwordHash: route.password_hash || config.auth.password_hash,
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, part) => {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function resolveLanguage(req) {
  const queryLang = typeof req.query?.lang === 'string' ? req.query.lang.toLowerCase() : '';
  if (SUPPORTED_LANGS.has(queryLang)) return queryLang;

  const cookieLang = parseCookies(req).lang;
  if (SUPPORTED_LANGS.has(cookieLang)) return cookieLang;

  const acceptLanguage = (req.headers['accept-language'] || '').toLowerCase();
  if (acceptLanguage.startsWith('en')) return 'en';
  return 'zh';
}

function translate(lang, key, vars = {}) {
  const dict = translations[lang] || translations.zh;
  let text = dict[key] || translations.zh[key] || key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

function verifyBasicAuth(req, loadConfig, route = null) {
  const config = loadConfig();
  const effectiveAuth = route ? getRouteEffectiveAuth(route, config) : {
    username: config.auth.username,
    passwordHash: config.auth.password_hash,
  };

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return false;
  try {
    const [user, pass] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    return user === effectiveAuth.username && hashPassword(pass) === effectiveAuth.passwordHash;
  } catch {
    return false;
  }
}

function sendBasicChallenge(res, realm, lang) {
  res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
  res.status(401).send(translate(lang, 'unauthorized'));
}

function getSubdomain(req, baseDomain = '') {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].toLowerCase();
  const normalizedBaseDomain = String(baseDomain || '').toLowerCase();

  if (!host || host === normalizedBaseDomain || host === 'localhost') return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;

  if (normalizedBaseDomain && host.endsWith(`.${normalizedBaseDomain}`)) {
    const sub = host.slice(0, -(normalizedBaseDomain.length + 1));
    return sub || null;
  }

  const parts = host.split('.');
  return parts.length >= 3 ? parts[0] : null;
}

function ensureDefaultAuth(loadConfig, saveConfig) {
  const config = loadConfig();
  if (!config.auth.password_hash) {
    config.auth.username = 'admin';
    config.auth.password_hash = hashPassword('admin');
    saveConfig(config);
    console.log('[!] Default credentials: admin / admin');
  }
}

function getLanguageSwitchHref(req, lang) {
  const targetLang = lang === 'zh' ? 'en' : 'zh';
  const url = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
  url.searchParams.set('lang', targetLang);
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ''}`;
}

function createApp(options = {}) {
  const { configFile = DEFAULT_CONFIG_FILE } = options;
  const store = createConfigStore(configFile);
  const { loadConfig, saveConfig } = store;
  const runtime = new RouteConfig(store);
  const tunnel = new TunnelConfig(store);
  const serialized = (config) => {
    const status = tunnel.status();
    return (config.routes || []).map((route) => sanitizeRoute(route, config, status));
  };

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', __dirname);

  const httpProxyInstance = httpProxy.createProxyServer({ ws: true, changeOrigin: true });
  httpProxyInstance.on('error', (err, req, res) => {
    console.error('[proxy error]', err.message);
    if (res.writeHead) res.writeHead(502);
    if (res.end) res.end('Proxy error: ' + err.message);
  });

  app.use((req, res, next) => {
    const lang = resolveLanguage(req);
    res.locals.lang = lang;
    res.locals.ui = translations[lang];
    res.locals.t = (key, vars) => translate(lang, key, vars);
    res.locals.languageSwitchHref = getLanguageSwitchHref(req, lang);

    const queryLang = typeof req.query?.lang === 'string' ? req.query.lang.toLowerCase() : '';
    if (SUPPORTED_LANGS.has(queryLang)) {
      res.cookie('lang', queryLang, { httpOnly: false, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000 });
    }

    next();
  });

  app.use((req, res, next) => {
    const currentConfig = loadConfig();
    const baseDomain = currentConfig.baseDomain || 'localhost';
    const subdomain = getSubdomain(req, baseDomain);
    const lang = res.locals.lang;

    if (subdomain) {
      const route = currentConfig.routes.find((r) => r.subdomain === subdomain);
      if (!route || new Route(route).path !== 'gateway') {
        res.status(404).send(translate(lang, 'routeNotConfigured', { subdomain }));
        return;
      }

      if (!verifyBasicAuth(req, loadConfig, route)) {
        sendBasicChallenge(res, baseDomain, lang);
        return;
      }

      const target = new Route(route).targetService;
      console.log(`[→] ${subdomain}.${baseDomain} ${req.method} ${req.path} → ${target}`);
      httpProxyInstance.web(req, res, { target });
      return;
    }

    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => {
    const currentConfig = loadConfig();
    if (!verifyBasicAuth(req, loadConfig)) {
      sendBasicChallenge(res, currentConfig.baseDomain || 'localhost', res.locals.lang);
      return;
    }

    next();
  });

  app.get('/', (req, res) => {
    const currentConfig = loadConfig();
    res.render('index.ejs', {
      baseDomain: currentConfig.baseDomain || 'localhost',
      routes: serialized(currentConfig),
      lang: res.locals.lang,
      ui: res.locals.ui,
      languageSwitchHref: res.locals.languageSwitchHref,
    });
  });

  app.get('/settings', (req, res) => {
    const currentConfig = loadConfig();
    res.render('settings.ejs', {
      error: null,
      success: null,
      baseDomain: currentConfig.baseDomain || 'localhost',
      lang: res.locals.lang,
      ui: res.locals.ui,
      languageSwitchHref: res.locals.languageSwitchHref,
    });
  });

  app.post('/settings/password', async (req, res) => {
    const { current, new_pass, confirm } = req.body;
    const cfg = loadConfig();
    const render = (error, success) => res.render('settings.ejs', {
      error,
      success,
      baseDomain: cfg.baseDomain || 'localhost',
      lang: res.locals.lang,
      ui: res.locals.ui,
      languageSwitchHref: res.locals.languageSwitchHref,
    });

    if (hashPassword(current) !== cfg.auth.password_hash) {
      return render(translate(res.locals.lang, 'currentPasswordWrong'), null);
    }
    if (new_pass !== confirm) {
      return render(translate(res.locals.lang, 'passwordMismatch'), null);
    }
    if ((new_pass || '').length < 4) {
      return render(translate(res.locals.lang, 'passwordTooShort'), null);
    }

    await runtime.mutate((latest) => { latest.auth.password_hash = hashPassword(new_pass); });
    return render(null, translate(res.locals.lang, 'passwordUpdated'));
  });

  app.get('/api/routes', (req, res) => {
    const currentConfig = loadConfig();
    res.json(serialized(currentConfig));
  });

  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Same-origin fetches include Origin. Non-browser API callers may omit it.
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
          return res.status(403).json({ error: 'Cross-origin write rejected' });
        }
      } catch { return res.status(403).json({ error: 'Invalid Origin' }); }
    } else if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
      return res.status(403).json({ error: 'Cross-origin write rejected' });
    }
    next();
  });

  app.get('/api/tunnel', (req, res) => res.json(tunnel.status()));
  app.post('/api/tunnel/apply', async (req, res) => {
    if (!req.headers.origin) return res.status(403).json({ error: 'Origin required to apply Tunnel changes' });
    try { res.json(await tunnel.apply()); }
    catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });

  app.post('/api/routes', async (req, res) => {
    try {
      const { subdomain, ip, port, description, username, password, original_subdomain } = req.body;
      if (!subdomain || !ip || !port) return res.status(400).json({ error: translate(res.locals.lang, 'requiredFields') });
      const cleanSub = String(subdomain).toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cleanSub)) {
        return res.status(400).json({ error: translate(res.locals.lang, 'invalidSubdomain') });
      }
      const type = req.body.type || 'http';
      if (!['http', 'tcp'].includes(type)) return res.status(400).json({ error: 'Unknown route type' });
      const cfg = await runtime.mutate((config) => {
        const originalSub = String(original_subdomain || cleanSub).toLowerCase();
        const idx = config.routes.findIndex((route) => route.subdomain === originalSub);
        if (original_subdomain && idx < 0) throw Object.assign(new Error('Original route no longer exists'), { status: 404 });
        const entry = { type, subdomain: cleanSub, ip, port, description: description || '', disabled: normalizeBoolean(req.body.disabled) };
        if (type === 'tcp') {
          if (username || password || normalizeBoolean(req.body.no_password) || req.body.password_hash || req.body.auth_mode) {
            throw Object.assign(new Error('TCP uses the target service authentication; HTTP credentials are not supported'), { status: 400 });
          }
        } else {
          const cleanUsername = String(username || '').trim();
          const cleanPassword = String(password || '').trim();
          entry.no_password = normalizeBoolean(req.body.no_password);
          const authMode = req.body.auth_mode || (cleanUsername || cleanPassword ? 'custom' : entry.no_password ? 'none' : 'default');
          if (!['custom', 'default', 'none'].includes(authMode)) throw Object.assign(new Error('Unknown authentication mode'), { status: 400 });
          if (authMode === 'custom' && entry.no_password || authMode === 'none' && !entry.no_password) {
            throw Object.assign(new Error('Authentication mode does not match the HTTP route mode'), { status: 400 });
          }
          if (!entry.no_password) {
            if (authMode === 'custom' || cleanUsername || cleanPassword) {
              if (!cleanUsername || !cleanPassword) throw Object.assign(new Error('Custom authentication requires both username and password'), { status: 400 });
              entry.username = cleanUsername;
              entry.password_hash = hashPassword(cleanPassword);
            }
          }
        }
        const model = new Route(entry);
        model.validate();
        entry.ip = model.host;
        entry.port = Number(port);
        if (idx >= 0) config.routes[idx] = entry;
        else config.routes.push(entry);
      });
      res.json({ ok: true, routes: serialized(cfg) });
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });

  app.patch('/api/routes/:subdomain', async (req, res) => {
    try {
      const cfg = await runtime.mutate((config) => {
        const route = config.routes.find((entry) => entry.subdomain === req.params.subdomain);
        if (!route) throw Object.assign(new Error('Route not found'), { status: 404 });
        route.disabled = normalizeBoolean(req.body.disabled);
      });
      res.json({ ok: true, routes: serialized(cfg) });
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });

  app.delete('/api/routes/:subdomain', async (req, res) => {
    try {
      const cfg = await runtime.mutate((config) => {
        config.routes = config.routes.filter((route) => route.subdomain !== req.params.subdomain);
      });
      res.json({ ok: true, routes: serialized(cfg) });
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  });

  const upgraded = new Set();
  const upgrade = (req, socket, head) => {
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    const currentConfig = loadConfig();
    const baseDomain = currentConfig.baseDomain || 'localhost';
    const subdomain = getSubdomain(req, baseDomain);
    if (!subdomain) return socket.destroy();

    const route = currentConfig.routes.find((r) => r.subdomain === subdomain);
    if (!route || new Route(route).path !== 'gateway') return socket.destroy();

    if (!verifyBasicAuth(req, loadConfig, route)) {
      socket.destroy();
      return;
    }

    httpProxyInstance.ws(req, socket, head, { target: new Route(route).targetService });
  };

  const listen = app.listen.bind(app);
  app.listen = (...args) => {
    const server = listen(...args);
    server.on('upgrade', upgrade);
    const close = server.close.bind(server);
    server.close = (callback) => {
      for (const socket of upgraded) socket.destroy();
      return close(callback);
    };
    return server;
  };
  app.locals.runtime = runtime;
  app.locals.ready = runtime.ready;
  app.locals.config = { loadConfig, saveConfig, configFile };
  return app;
}

async function startServer(options = {}) {
  const app = createApp(options);
  const { loadConfig, saveConfig } = app.locals.config;
  await app.locals.ready;
  ensureDefaultAuth(loadConfig, saveConfig);

  const config = loadConfig();
  const port = config.port || 8080;
  const baseDomain = config.baseDomain || 'localhost';

  const server = app.listen(port, '0.0.0.0');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
  });
  const latestConfig = loadConfig();
  console.log(`✓ Proxy server running at http://localhost:${port}`);
  console.log(`✓ Base domain: ${baseDomain}`);
  console.log(`✓ Routes configured: ${(latestConfig.routes || []).length}`);
  return server;
}

if (require.main === module) {
  startServer().then((server) => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }).catch((error) => { console.error('Flux Gate startup failed:', error.message); process.exitCode = 1; });
}

module.exports = {
  createApp,
  createConfigStore,
  hashPassword,
  parseCookies,
  resolveLanguage,
  startServer,
  translate,
  translations,
};
