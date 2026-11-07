/*
 * 文件说明: 管理真实 loopback TCP 监听、配置预留与连接生命周期，使用标准流实现背压及半关闭。
 * 对应文档: docs/tcp-forwarding.md
 */
const net = require('node:net');

function isTcp(route) { return route.type === 'tcp'; }

class TcpListeners {
  constructor() {
    this.listeners = new Map();
    this.totalConnections = 0;
    this.closed = false;
  }

  status(route) {
    if (route.disabled) return 'disabled';
    const listener = this.listeners.get(Number(route.listen_port));
    return listener?.route?.subdomain === route.subdomain && listener.server.listening ? 'listening' : 'pending';
  }

  async prepare(routes) {
    if (this.closed) throw new Error('TCP listeners are shutting down');
    const staged = new Map();
    try {
      for (const route of routes.filter((entry) => isTcp(entry) && !entry.disabled)) {
        const port = Number(route.listen_port);
        if (this.listeners.has(port)) continue;
        const listener = { route: null, server: null, connections: new Set() };
        listener.server = net.createServer({ allowHalfOpen: true }, (client) => this.accept(listener, client));
        await new Promise((resolve, reject) => {
          listener.server.once('error', reject);
          listener.server.listen(port, '127.0.0.1', () => {
            listener.server.off('error', reject);
            resolve();
          });
        });
        listener.server.on('error', (error) => console.error('[tcp listener]', error.code || 'listener error'));
        staged.set(port, listener);
        if (this.closed) throw new Error('TCP listeners are shutting down');
      }
      return {
        commit: () => {
          if (this.closed) {
            for (const listener of staged.values()) this.stop(listener);
            throw new Error('TCP listeners are shutting down');
          }
          const next = new Map();
          for (const route of routes.filter((entry) => isTcp(entry) && !entry.disabled)) {
            const port = Number(route.listen_port);
            const listener = this.listeners.get(port) || staged.get(port);
            if (listener.route && (listener.route.ip !== route.ip || Number(listener.route.port) !== Number(route.port) || listener.route.subdomain !== route.subdomain)) {
              this.disconnect(listener);
            }
            listener.route = route;
            next.set(port, listener);
          }
          for (const [port, listener] of this.listeners) if (!next.has(port)) this.stop(listener);
          this.listeners = next;
        },
        rollback: () => { for (const listener of staged.values()) this.stop(listener); },
      };
    } catch (error) {
      for (const listener of staged.values()) this.stop(listener);
      throw error;
    }
  }

  accept(listener, client) {
    if (!listener.route || this.closed || listener.connections.size >= 32 || this.totalConnections >= 128) {
      client.destroy(); return;
    }
    const route = listener.route;
    const upstream = net.connect({ host: route.ip, port: Number(route.port), allowHalfOpen: true });
    const pair = { client, upstream };
    listener.connections.add(pair);
    this.totalConnections++;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      listener.connections.delete(pair);
      this.totalConnections--;
      client.destroy(); upstream.destroy();
    };
    const timeout = setTimeout(cleanup, 10_000);
    timeout.unref();
    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
    upstream.once('connect', () => clearTimeout(timeout));
    client.setKeepAlive(true, 30_000);
    upstream.setKeepAlive(true, 30_000);
    client.pipe(upstream).pipe(client);
  }

  disconnect(listener) {
    for (const { client, upstream } of listener.connections) { client.destroy(); upstream.destroy(); }
  }

  stop(listener) {
    listener.route = null;
    this.disconnect(listener);
    listener.server.close();
  }

  close() {
    this.closed = true;
    for (const listener of this.listeners.values()) this.stop(listener);
    this.listeners.clear();
  }
}

module.exports = { TcpListeners, isTcp };
