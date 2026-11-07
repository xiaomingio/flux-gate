/*
 * 文件说明: 串行保存路由配置，提交前预留 TCP 端口，失败时保持原配置和现有监听。
 * 对应文档: docs/tcp-forwarding.md
 */
const { TcpListeners, isTcp } = require('./TcpListeners');

function validateRoutes(routes, adminPort = 8080) {
  const names = new Set(), ports = new Set();
  for (const route of routes) {
    if (route.type && !['http', 'tcp'].includes(route.type)) throw Object.assign(new Error('Unknown route type'), { status: 400 });
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(route.subdomain || '')) throw Object.assign(new Error('Invalid route name'), { status: 400 });
    if (!route.subdomain || names.has(route.subdomain)) throw Object.assign(new Error('Route name already exists'), { status: 409 });
    names.add(route.subdomain);
    if (!isTcp(route)) continue;
    if (route.username || route.password_hash || route.no_password) throw Object.assign(new Error('TCP routes cannot use HTTP authentication fields'), { status: 400 });
    if (!Number.isInteger(route.listen_port) || route.listen_port < 1024 || route.listen_port > 65535) {
      throw Object.assign(new Error('TCP listen_port must be an integer from 1024 to 65535'), { status: 400 });
    }
    if (!Number.isInteger(Number(route.port)) || Number(route.port) < 1 || Number(route.port) > 65535 ||
        typeof route.ip !== 'string' || !/^[a-zA-Z0-9._:-]+$/.test(route.ip)) {
      throw Object.assign(new Error('TCP target host or port is invalid'), { status: 400 });
    }
    if (route.listen_port === Number(adminPort)) throw Object.assign(new Error('TCP listen port conflicts with the admin server'), { status: 409 });
    if (ports.has(route.listen_port)) throw Object.assign(new Error('TCP listen port already belongs to another route'), { status: 409 });
    if (['127.0.0.1', 'localhost', '::1'].includes(route.ip) && Number(route.port) === route.listen_port) {
      throw Object.assign(new Error('TCP route cannot forward to itself'), { status: 400 });
    }
    ports.add(route.listen_port);
  }
}

class RouteConfig {
  constructor(store) {
    this.store = store;
    this.tcp = new TcpListeners();
    this.queue = Promise.resolve();
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }

  async initialize() {
    const config = this.store.loadConfig();
    validateRoutes(config.routes || [], config.port || 8080);
    const prepared = await this.tcp.prepare(config.routes || []);
    prepared.commit();
  }

  mutate(change) {
    const operation = this.queue.then(async () => {
      await this.ready;
      const config = this.store.loadConfig();
      change(config);
      validateRoutes(config.routes || [], config.port || 8080);
      let prepared;
      try {
        try { prepared = await this.tcp.prepare(config.routes || []); }
        catch (error) {
          if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
            throw Object.assign(new Error('TCP listen port is unavailable; existing configuration kept'), { status: 409 });
          }
          throw error;
        }
        this.store.saveConfig(config);
        prepared.commit();
        return config;
      } catch (error) {
        prepared?.rollback();
        throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  close() { this.tcp.close(); }
}

module.exports = RouteConfig;
