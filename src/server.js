/*
 * 文件说明: 提供 flux-gate 的子域名反向代理与管理界面入口，代理请求不经过 body parser 直接转发给后端。
 * 参考资料: config.sample.json
 */
const express = require('express');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    } catch {
      return {
        port: 8080,
        baseDomain: 'localhost',
        auth: { username: 'admin', password_hash: '' },
        routes: [],
      };
    }
  }

  function saveConfig(cfg) {
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
  }

  return { loadConfig, saveConfig, configFile };
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 1 || value === 'on';
}

function sanitizeRoute(route) {
  return {
    subdomain: route.subdomain,
    ip: route.ip,
    port: route.port,
    description: route.description || '',
    username: route.username || '',
    no_password: Boolean(route.no_password),
    disabled: Boolean(route.disabled),
    has_custom_auth: Boolean(route.username || route.password_hash),
  };
}

function getRouteEffectiveAuth(route, config) {
  if (route.no_password) return { noPassword: true };

  return {
    noPassword: false,
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
    noPassword: false,
    username: config.auth.username,
    passwordHash: config.auth.password_hash,
  };

  if (effectiveAuth.noPassword) return true;

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
  const { loadConfig, saveConfig } = createConfigStore(configFile);

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
      if (!route || route.disabled) {
        res.status(404).send(translate(lang, 'routeNotConfigured', { subdomain }));
        return;
      }

      if (!verifyBasicAuth(req, loadConfig, route)) {
        sendBasicChallenge(res, baseDomain, lang);
        return;
      }

      const target = `http://${route.ip}:${route.port}`;
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
      routes: (currentConfig.routes || []).map(sanitizeRoute),
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

  app.post('/settings/password', (req, res) => {
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

    cfg.auth.password_hash = hashPassword(new_pass);
    saveConfig(cfg);
    return render(null, translate(res.locals.lang, 'passwordUpdated'));
  });

  app.get('/api/routes', (req, res) => {
    const currentConfig = loadConfig();
    res.json((currentConfig.routes || []).map(sanitizeRoute));
  });

  app.post('/api/routes', (req, res) => {
    const { subdomain, ip, port, description, username, password, original_subdomain } = req.body;
    if (!subdomain || !ip || !port) {
      return res.status(400).json({ error: translate(res.locals.lang, 'requiredFields') });
    }

    const cleanSub = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!cleanSub) {
      return res.status(400).json({ error: translate(res.locals.lang, 'invalidSubdomain') });
    }

    const cfg = loadConfig();
    const originalSub = String(original_subdomain || cleanSub).toLowerCase();
    const idx = cfg.routes.findIndex((r) => r.subdomain === originalSub);
    const previous = idx >= 0 ? cfg.routes[idx] : null;
    const cleanUsername = String(username || '').trim();
    const cleanPassword = String(password || '').trim();
    const noPassword = normalizeBoolean(req.body.no_password);
    const disabled = normalizeBoolean(req.body.disabled);

    const entry = {
      subdomain: cleanSub,
      ip,
      port,
      description: description || '',
      no_password: noPassword,
      disabled,
    };

    const keepExistingCustomAuth = !noPassword && !cleanUsername && !cleanPassword ? false : Boolean(previous?.username || previous?.password_hash);

    if (cleanUsername) entry.username = cleanUsername;
    else if (cleanPassword && previous?.username) entry.username = previous.username;

    if (cleanPassword) entry.password_hash = hashPassword(cleanPassword);
    else if (!cleanUsername && !cleanPassword) {
      // leave custom auth cleared so the route falls back to default credentials
    } else if (previous?.password_hash && (cleanUsername || keepExistingCustomAuth)) {
      entry.password_hash = previous.password_hash;
    }

    if (idx >= 0) cfg.routes[idx] = entry;
    else cfg.routes.push(entry);
    saveConfig(cfg);

    return res.json({ ok: true, routes: cfg.routes.map(sanitizeRoute) });
  });

  app.patch('/api/routes/:subdomain', (req, res) => {
    const cfg = loadConfig();
    const idx = cfg.routes.findIndex((r) => r.subdomain === req.params.subdomain);
    if (idx < 0) {
      return res.status(404).json({ error: translate(res.locals.lang, 'routeNotConfigured', { subdomain: req.params.subdomain }) });
    }

    cfg.routes[idx] = {
      ...cfg.routes[idx],
      disabled: normalizeBoolean(req.body.disabled),
    };
    saveConfig(cfg);
    return res.json({ ok: true, routes: cfg.routes.map(sanitizeRoute) });
  });

  app.delete('/api/routes/:subdomain', (req, res) => {
    const cfg = loadConfig();
    cfg.routes = cfg.routes.filter((r) => r.subdomain !== req.params.subdomain);
    saveConfig(cfg);
    res.json({ ok: true, routes: cfg.routes });
  });

  app.on('upgrade', (req, socket, head) => {
    const currentConfig = loadConfig();
    const baseDomain = currentConfig.baseDomain || 'localhost';
    const subdomain = getSubdomain(req, baseDomain);
    if (!subdomain) return;

    const route = currentConfig.routes.find((r) => r.subdomain === subdomain);
    if (!route || route.disabled) return;

    if (!verifyBasicAuth(req, loadConfig, route)) {
      socket.destroy();
      return;
    }

    httpProxyInstance.ws(req, socket, head, { target: `http://${route.ip}:${route.port}` });
  });

  app.locals.config = { loadConfig, saveConfig, configFile };
  return app;
}

function startServer(options = {}) {
  const app = createApp(options);
  const { loadConfig, saveConfig } = app.locals.config;
  ensureDefaultAuth(loadConfig, saveConfig);

  const config = loadConfig();
  const port = config.port || 8080;
  const baseDomain = config.baseDomain || 'localhost';

  return app.listen(port, '0.0.0.0', () => {
    const latestConfig = loadConfig();
    console.log(`✓ Proxy server running at http://localhost:${port}`);
    console.log(`✓ Base domain: ${baseDomain}`);
    console.log(`✓ Routes configured: ${(latestConfig.routes || []).length}`);
  });
}

if (require.main === module) {
  startServer();
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
