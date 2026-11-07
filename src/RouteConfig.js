/*
 * 文件说明: 串行执行配置保存与业务 Tunnel 自动同步，失败回退并保留可核验操作回执。
 * 对应文档: docs/tcp-forwarding.md
 */
const Route = require('./Route');
const OperationReceipts = require('./OperationReceipts');

function validateRoutes(routes) {
  const names = new Set();
  for (const route of routes) {
    new Route(route).validate();
    if (!route.subdomain || names.has(route.subdomain)) throw Object.assign(new Error('Route name already exists'), { status: 409 });
    names.add(route.subdomain);
  }
}

class RouteConfig {
  constructor(store, tunnel) {
    this.store = store;
    this.tunnel = tunnel;
    this.receipts = new OperationReceipts(`${store.configFile}.flux-gate-operations.json`);
    this.queue = Promise.resolve();
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }

  async initialize() {
    const config = this.store.loadConfig();
    validateRoutes(config.routes || []);
  }

  operation(id) { return this.receipts.get(id, this.store.loadConfig(), this.tunnel.status()); }

  mutate(change, requestedId) {
    const id = this.receipts.create(requestedId);
    const operation = this.queue.then(async () => {
      let saved = false, rolledBack = false;
      try {
        await this.ready;
        this.receipts.update(id, 'running');
        const perform = async (publish) => {
          const original = this.store.loadConfig();
          const config = structuredClone(original);
          change(config);
          validateRoutes(config.routes || []);
          this.store.saveConfig(config);
          saved = true;
          try {
            if (publish && (await publish()).status !== 'applied') throw new Error('Tunnel routing was not confirmed');
            this.receipts.update(id, publish ? 'applied' : 'local_only', config);
            return { config, operation: this.operation(id), tunnel: this.tunnel.status() };
          } catch (error) {
            if (JSON.stringify(this.store.loadConfig()) !== JSON.stringify(config)) throw new Error('Configuration changed externally; rollback was not attempted. Inspect the host before retrying');
            this.store.saveConfig(original);
            if (publish && this.tunnel.status().status !== 'applied' && (await publish()).status !== 'applied') throw new Error('Previous Tunnel routing could not be confirmed; use host recovery access');
            rolledBack = true;
            throw error;
          }
        };
        return this.tunnel.settings().enabled ? await this.tunnel.transaction(perform) : await perform(null);
      } catch (error) {
        const message = saved ? rolledBack ? 'Change could not be applied; previous configuration restored' : 'Change failed and recovery is unconfirmed; inspect the host before retrying' : error.message;
        try { this.receipts.update(id, rolledBack ? 'rolled_back' : 'error', rolledBack ? this.store.loadConfig() : null, message); } catch {}
        throw Object.assign(new Error(message), { status: error.status || 500, operationId: id });
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = RouteConfig;
