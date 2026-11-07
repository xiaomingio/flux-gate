/*
 * 文件说明: 定义 HTTP/TCP 路由的目标校验、原生 Tunnel 接线与密码保护分支。
 * 对应文档: docs/tcp-forwarding.md
 */
const net = require('node:net');

class Route {
  constructor(data) { this.data = data; }

  get isTcp() { return this.data.type === 'tcp'; }
  get path() { return this.data.disabled ? 'blocked' : this.isTcp || this.data.no_password ? 'direct' : 'gateway'; }
  get host() {
    const value = this.data.ip;
    return typeof value === 'string' && value.startsWith('[') && value.endsWith(']') && net.isIP(value.slice(1, -1)) === 6 ? value.slice(1, -1) : value;
  }
  get authority() { return `${net.isIP(this.host) === 6 ? `[${this.host}]` : this.host}:${Number(this.data.port)}`; }
  get targetService() { return `${this.isTcp ? 'tcp' : 'http'}://${this.authority}`; }

  validate() {
    const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
    if (this.data.type && !['http', 'tcp'].includes(this.data.type)) fail('Unknown route type');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(this.data.subdomain || '')) fail('Invalid route name');
    const host = this.host;
    if (typeof host !== 'string') fail('Target host must be an IP address or hostname');
    const hostname = typeof host === 'string' && host.length <= 253 && host.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
    if (!net.isIP(host || '') && (!hostname || /^[\d.]+$/.test(host))) fail('Target host must be an IP address or hostname');
    if (!(typeof this.data.port === 'number' || typeof this.data.port === 'string' && /^\d+$/.test(this.data.port)) ||
        !Number.isInteger(Number(this.data.port)) || Number(this.data.port) < 1 || Number(this.data.port) > 65535) fail('Target port must be an integer from 1 to 65535');
    if (this.isTcp && (this.data.username || this.data.password_hash || this.data.no_password)) fail('TCP routes cannot use HTTP authentication fields');
  }

  rule(config) {
    this.validate();
    const rule = { hostname: `${this.data.subdomain}.${config.baseDomain}` };
    if (this.path === 'blocked') return { ...rule, service: 'http_status:404' };
    if (this.path === 'gateway') return { ...rule, service: `http://127.0.0.1:${Number(config.port) || 8080}` };
    return { ...rule, service: this.targetService, ...(!this.isTcp && { originRequest: { httpHostHeader: this.authority } }) };
  }

  static servicePath(service, config, originRequest) {
    if (service === 'http_status:404') return 'blocked';
    if (originRequest?.httpHostHeader && /^https?:\/\//.test(service || '')) return 'direct';
    if (service === `http://127.0.0.1:${Number(config.port) || 8080}`) return 'gateway';
    if (/^(http|https|tcp|ssh):\/\//.test(service || '')) return 'direct';
    return service ? 'unmanaged' : 'unknown';
  }
}

module.exports = Route;
