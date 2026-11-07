/*
 * 文件说明: 验证管理页渲染、路由鉴权和配置保存的 HTTP 契约。
 * 对应文档: README.md
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp, hashPassword } = require('../src/server');

function createTestConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-gate-'));
  const configPath = path.join(dir, 'config.json');
  const baseConfig = {
    port: 0,
    baseDomain: 'example.com',
    auth: {
      username: 'admin',
      password_hash: hashPassword('admin'),
    },
    routes: [
      { subdomain: 'workspace', ip: '192.168.1.10', port: '8888', description: 'Workspace' },
      { subdomain: 'nas', ip: '192.168.1.100', port: '8080', description: '' },
    ],
  };

  const finalConfig = {
    ...baseConfig,
    ...overrides,
    auth: {
      ...baseConfig.auth,
      ...(overrides.auth || {}),
    },
    routes: overrides.routes || baseConfig.routes,
  };

  fs.writeFileSync(configPath, JSON.stringify(finalConfig, null, 2));
  return { dir, configPath };
}

async function withServer(fn, configOverrides = {}) {
  const { dir, configPath } = createTestConfig(configOverrides);
  const app = createApp({ configFile: configPath });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const port = server.address().port;
    await fn({
      baseUrl: `http://127.0.0.1:${port}`,
      authHeader: `Basic ${Buffer.from('admin:admin').toString('base64')}`,
      configPath,
    });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('server loads translations from locale JSON files', async () => {
  const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'en.json'), 'utf8'));
  const { translations } = require('../src/server');

  assert.equal(zh.dashboardTitle, '控制面板');
  assert.equal(en.authSectionTitle, 'Authentication');
  assert.deepEqual(translations.zh, zh);
  assert.deepEqual(translations.en, en);
});

test('GET / supports English via lang query and sets locale cookie', async () => {
  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(`${baseUrl}/?lang=en`, {
      headers: {
        Authorization: authHeader,
      },
      redirect: 'manual',
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /Proxy Manager/);
    assert.match(html, /All Routes/);
    assert.match(html, /<title>[^<]*Flux Gate[^<]*<\/title>/);
    assert.match(html, /cdn\.tailwindcss\.com/);
    assert.match(response.headers.get('set-cookie') || '', /lang=en/i);
  });
});

test('GET / renders Flux Gate branding and dashboard hero in Chinese', async () => {
  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: authHeader,
      },
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /Flux Gate/);
    assert.match(html, /一站式内网服务发布面板/);
    assert.match(html, /rounded-3xl/);
  });
});

test('GET / renders route title as the clickable link and uses icon-only delete control', async () => {
  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: authHeader,
      },
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /group-hover:text-sky-600/);
    assert.doesNotMatch(html, />\s*🔗\s*(Open|访问)\s*</);
    assert.doesNotMatch(html, /🗑️\s*(Delete|删除)/);
  });
});

test('GET / renders red auth badge for no-password routes', async () => {
  const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'zh.json'), 'utf8'));

  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: authHeader,
      },
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /border-red-200 bg-red-50 text-red-700/);
    assert.match(html, new RegExp(zh.authNoneLabel));
    assert.match(html, new RegExp(zh.authDefaultLabel));
  }, {
    routes: [
      {
        subdomain: 'public',
        ip: '192.168.1.99',
        port: '8081',
        description: 'Public route',
        no_password: true,
      },
    ],
  });
});

test('GET / renders route status and auth badges with unified chip style', async () => {
  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: authHeader,
      },
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /rounded-full border px-2\.5 py-1/);
    assert.match(html, /在线|已停用|无密码|自定义/);
  }, {
    routes: [
      { subdomain: 'custom', ip: '192.168.1.10', port: '3000', description: 'Custom auth', username: 'alice', password_hash: hashPassword('secret') },
      { subdomain: 'public', ip: '192.168.1.11', port: '3001', description: 'Public', no_password: true },
      { subdomain: 'off', ip: '192.168.1.12', port: '3002', description: 'Off', disabled: true },
    ],
  });
});

test('GET / renders auth mode options and custom inputs are conditional', async () => {
  const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'zh.json'), 'utf8'));

  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: authHeader,
      },
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, new RegExp(zh.authDefaultLabel));
    assert.match(html, new RegExp(zh.authCustomLabel));
    assert.match(html, new RegExp(zh.authNoneLabel));
    assert.match(html, /<form class="grid min-w-0 gap-4" onsubmit="saveRoute\(event\)">/);
    assert.match(html, /class="flex min-w-0 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900\/70/);
    assert.match(html, /class="inline-flex shrink-0 items-center border-l border-slate-700 bg-slate-900 px-4 text-sm font-medium text-slate-400"/);
    assert.match(html, /w-full min-w-0 rounded-2xl border border-slate-700 bg-slate-900\/70/);
  });
});

test('GET \/ shows the full subdomain with base domain suffix in the input group', async () => {
  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: authHeader,
      },
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /id="f-sub"/);
    assert.match(html, />\.example\.com<\/span>/);
  });
});

test('GET /settings renders English when locale cookie is present', async () => {
  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(`${baseUrl}/settings`, {
      headers: {
        Authorization: authHeader,
        Cookie: 'lang=en',
      },
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /Change Password/);
    assert.match(html, /Back to Dashboard/);
    assert.doesNotMatch(html, /修改密码/);
  });
});

test('GET / renders English auth labels when locale cookie is present', async () => {
  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(`${baseUrl}/?lang=en`, {
      headers: {
        Authorization: authHeader,
      },
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /Authentication/);
    assert.match(html, /Default credentials/);
    assert.match(html, /Custom/);
    assert.match(html, /No password/);
  });
});

test('POST /api/routes persists per-route auth, no-password, and disabled state', async () => {
  await withServer(async ({ baseUrl, authHeader, configPath }) => {
    const response = await fetch(`${baseUrl}/api/routes`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subdomain: 'docs',
        ip: '192.168.1.20',
        port: '3001',
        description: 'Docs',
        username: 'alice',
        password: 'secret123',
        no_password: false,
        disabled: true,
      }),
    });

    assert.equal(response.status, 200);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const route = config.routes.find((item) => item.subdomain === 'docs');

    assert.equal(route.username, 'alice');
    assert.equal(route.password_hash, hashPassword('secret123'));
    assert.equal(route.no_password, false);
    assert.equal(route.disabled, true);
  });
});

test('subdomain route can use its own username and password', async () => {
  await withServer(async ({ baseUrl }) => {
    const unauthorized = await fetch(`${baseUrl}/`, {
      headers: {
        'x-forwarded-host': 'docs.example.com',
        Authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}`,
      },
      redirect: 'manual',
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/`, {
      headers: {
        'x-forwarded-host': 'docs.example.com',
        Authorization: `Basic ${Buffer.from('alice:secret123').toString('base64')}`,
      },
      redirect: 'manual',
    });
    assert.equal(authorized.status, 502);
  }, {
    routes: [
      {
        subdomain: 'docs',
        ip: '127.0.0.1',
        port: '65535',
        description: 'Docs',
        username: 'alice',
        password_hash: hashPassword('secret123'),
      },
    ],
  });
});

test('subdomain route can disable password and disabled routes are not available', async () => {
  await withServer(async ({ baseUrl }) => {
    const noPasswordRoute = await fetch(`${baseUrl}/`, {
      headers: {
        'x-forwarded-host': 'public.example.com',
      },
      redirect: 'manual',
    });
    assert.equal(noPasswordRoute.status, 502);

    const disabledRoute = await fetch(`${baseUrl}/`, {
      headers: {
        'x-forwarded-host': 'off.example.com',
        Authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}`,
      },
      redirect: 'manual',
    });
    assert.equal(disabledRoute.status, 404);
  }, {
    routes: [
      {
        subdomain: 'public',
        ip: '127.0.0.1',
        port: '65535',
        description: 'Public',
        no_password: true,
      },
      {
        subdomain: 'off',
        ip: '127.0.0.1',
        port: '65535',
        description: 'Off',
        disabled: true,
      },
    ],
  });
});

test('GET / renders edit and disable controls for route cards', async () => {
  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(baseUrl, {
      headers: {
        Authorization: authHeader,
      },
    });

    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /username/);
    assert.match(html, /no_password/);
    assert.match(html, /flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start/);
    assert.match(html, /w-full min-w-0 rounded-3xl border/);
    assert.match(html, /grid min-w-0 gap-3 md:grid-cols-2/);
    assert.match(html, /flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-end sm:justify-start sm:self-start/);
  }, {
    routes: [
      {
        subdomain: 'workspace',
        ip: '192.168.1.10',
        port: '8888',
        description: 'Workspace',
        disabled: true,
      },
    ],
  });
});

test('POST /api/routes returns translated validation error in English', async () => {
  await withServer(async ({ baseUrl, authHeader }) => {
    const response = await fetch(`${baseUrl}/api/routes`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Cookie: 'lang=en',
      },
      body: JSON.stringify({ subdomain: '', ip: '', port: '' }),
    });

    assert.equal(response.status, 400);
    const data = await response.json();

    assert.equal(data.error, 'Required fields cannot be empty');
  });
});
