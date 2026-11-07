/*
 * 文件说明: 串行校验和原子保存路由配置；公网接线由显式 Tunnel 发布管理。
 * 对应文档: docs/tcp-forwarding.md
 */
const Route = require('./Route');

function validateRoutes(routes) {
  const names = new Set();
  for (const route of routes) {
    new Route(route).validate();
    if (!route.subdomain || names.has(route.subdomain)) throw Object.assign(new Error('Route name already exists'), { status: 409 });
    names.add(route.subdomain);
  }
}

class RouteConfig {
  constructor(store) {
    this.store = store;
    this.queue = Promise.resolve();
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }

  async initialize() {
    const config = this.store.loadConfig();
    validateRoutes(config.routes || []);
  }

  mutate(change) {
    const operation = this.queue.then(async () => {
      await this.ready;
      const config = this.store.loadConfig();
      change(config);
      validateRoutes(config.routes || []);
      this.store.saveConfig(config);
      return config;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = RouteConfig;
