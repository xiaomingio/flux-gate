/*
 * 文件说明: 发布 HTTP/TCP 原生 Tunnel 接线，区分保存与应用状态，保留无关入口及恢复点。
 * 对应文档: docs/tcp-forwarding.md
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const YAML = require('yaml');
const Route = require('./Route');

const BEGIN = '  # BEGIN FLUX GATE ROUTES';
const END = '  # END FLUX GATE ROUTES';
const LEGACY_BEGIN = '  # BEGIN FLUX GATE TCP';
const LEGACY_END = '  # END FLUX GATE TCP';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function execute(command, args) {
  return new Promise((resolve, reject) => childProcess.execFile(command, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error) => {
    if (error) reject(new Error(`${command} ${command === 'pm2' ? 'restart' : 'validation'} failed; previous configuration restored`));
    else resolve();
  }));
}
function atomic(file, contents) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

class TunnelConfig {
  constructor(store) { this.store = store; this.busy = false; }

  settings() {
    const config = this.store.loadConfig();
    const integration = config.tunnel || {};
    const file = integration.config_file || path.join(os.homedir(), '.cloudflared/config.yml');
    const processName = integration.process_name || 'cloudflare-tunnel';
    if (!path.isAbsolute(file) || !/^[a-zA-Z0-9_.-]+$/.test(processName)) throw new Error('Invalid Tunnel integration settings');
    return { config, file, processName, enabled: integration.enabled === true };
  }

  rules(config) {
    if (!/^[a-zA-Z0-9.-]+$/.test(config.baseDomain || '')) throw new Error('Invalid base domain');
    return (config.routes || []).map((route) => new Route(route).rule(config));
  }

  managed(original) {
    let without = original, entries = [], sections = 0;
    for (const [begin, end] of [[BEGIN, END], [LEGACY_BEGIN, LEGACY_END]]) {
      const beginCount = original.split(begin).length - 1, endCount = original.split(end).length - 1;
      if (beginCount !== endCount || beginCount > 1) throw new Error('Invalid managed route markers');
      if (!beginCount) continue;
      sections++;
      const pattern = new RegExp(`^${begin}\\r?\\n([\\s\\S]*?)^${end}\\r?\\n?`, 'm');
      const match = without.match(pattern);
      if (!match) throw new Error('Invalid managed route section');
      entries = YAML.parse(match[1]) || [];
      if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.hostname !== 'string' || entry.path || entry.hostname.includes('*'))) throw new Error('Managed section must contain explicit hostname rules');
      without = without.replace(pattern, '');
    }
    if (sections > 1) throw new Error('Multiple managed route sections; inspect configuration before applying');
    return { without, entries };
  }

  candidate(original, rules) {
    const { without, entries } = this.managed(original);
    const parsed = YAML.parse(without);
    if (!parsed || !Array.isArray(parsed.ingress) || !/^ingress:\s*\r?\n/m.test(without)) throw new Error('Tunnel ingress must be a block list');
    // Keep removed/renamed hostnames blocked so an HTTP wildcard cannot reopen them.
    rules = [...rules, ...entries.filter((entry) => !rules.some((rule) => rule.hostname === entry.hostname))
      .map((entry) => ({ hostname: entry.hostname, service: 'http_status:404' }))];
    for (const rule of rules) {
      if (parsed.ingress.some((entry) => entry.hostname === rule.hostname)) throw new Error(`Hostname ${rule.hostname} already belongs to an unmanaged Tunnel route`);
    }
    const body = rules.length ? YAML.stringify(rules).trimEnd().split('\n').map((line) => `  ${line}`).join('\n') + '\n' : '';
    const block = `${BEGIN}\n${body}${END}\n`;
    const updated = without.replace(/^ingress:\s*\r?\n/m, (line) => line + block);
    YAML.parse(updated);
    return updated;
  }

  status() {
    try {
      const settings = this.settings();
      const rules = this.rules(settings.config);
      if (!settings.enabled) return { enabled: false, status: 'disabled', rules, current_rules: [], current_verified: false, changes: [] };
      const original = fs.readFileSync(settings.file, 'utf8');
      const desired = this.candidate(original, rules);
      let receipt;
      try { receipt = JSON.parse(fs.readFileSync(`${settings.file}.flux-gate-applied.json`, 'utf8')); } catch {}
      const verified = receipt?.sha256 === hash(original);
      const desiredRules = this.managed(desired).entries;
      const ingress = YAML.parse(original).ingress;
      const currentRules = verified ? this.managed(original).entries : [];
      const changes = desiredRules.map((rule) => {
        const current = verified ? ingress.find((entry) => !entry.path && (!entry.hostname || entry.hostname === rule.hostname ||
          entry.hostname.startsWith('*.') && rule.hostname.endsWith(entry.hostname.slice(1)))) : null;
        const same = current && JSON.stringify(current) === JSON.stringify(rule);
        return { hostname: rule.hostname, desired_service: rule.service, current_service: current?.service || null,
          desired_path: Route.servicePath(rule.service, settings.config, rule.originRequest),
          current_path: verified ? Route.servicePath(current?.service, settings.config, current?.originRequest) : 'unknown',
          status: same ? 'applied' : 'pending' };
      });
      return { enabled: true, status: desired === original && verified ? 'applied' : 'pending',
        rules: desiredRules, current_rules: currentRules, current_verified: verified, changes };
    } catch (error) { return { enabled: true, status: 'error', rules: [], current_rules: [], current_verified: false, changes: [], error: error.message }; }
  }

  async apply() {
    if (this.busy) throw Object.assign(new Error('Tunnel publish is already running'), { status: 409 });
    this.busy = true;
    let lock, lockFile, candidateFile;
    try {
      const settings = this.settings();
      const routeSnapshot = JSON.stringify(settings.config);
      if (!settings.enabled) throw Object.assign(new Error('Tunnel integration is disabled in configuration'), { status: 409 });
      lockFile = `${settings.file}.flux-gate.lock`;
      try { lock = fs.openSync(lockFile, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw Object.assign(new Error('Tunnel configuration is locked; inspect any previous publish before retrying'), { status: 409 });
        throw error;
      }
      const original = fs.readFileSync(settings.file, 'utf8');
      const updated = this.candidate(original, this.rules(settings.config));
      if (updated === original && this.status().status === 'applied') return { ok: true, ...this.status() };
      candidateFile = `${settings.file}.${crypto.randomUUID()}.candidate`;
      fs.writeFileSync(candidateFile, updated, { mode: 0o600, flag: 'wx' });
      await execute('cloudflared', ['--config', candidateFile, 'tunnel', 'ingress', 'validate']);
      const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).replace(/\D/g, '');
      const backup = path.join(os.homedir(), 'backups/flux-gate/tunnel', `${stamp}-${crypto.randomUUID()}.yml`);
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      fs.writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
      if (fs.readFileSync(settings.file, 'utf8') !== original) throw new Error('Tunnel configuration changed concurrently; nothing replaced');
      if (JSON.stringify(this.store.loadConfig()) !== routeSnapshot) throw new Error('Routes changed while preparing Tunnel publish; nothing replaced');
      fs.renameSync(candidateFile, settings.file);
      candidateFile = null;
      const receiptFile = `${settings.file}.flux-gate-applied.json`;
      if (fs.existsSync(receiptFile)) fs.unlinkSync(receiptFile);
      try {
        await execute('pm2', ['restart', settings.processName]);
        atomic(`${settings.file}.flux-gate-applied.json`, JSON.stringify({ sha256: hash(updated) }));
      } catch (error) {
        atomic(settings.file, original);
        try { await execute('pm2', ['restart', settings.processName]); }
        catch { throw new Error('Tunnel publish failed; original file restored but recovery restart failed. Use host recovery access.'); }
        throw error;
      }
      return { ok: true, backup, ...this.status() };
    } finally {
      if (candidateFile && fs.existsSync(candidateFile)) fs.unlinkSync(candidateFile);
      if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockFile); }
      this.busy = false;
    }
  }
}

module.exports = TunnelConfig;
