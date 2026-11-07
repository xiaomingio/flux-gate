/*
 * 文件说明: 对受控 Cloudflare Tunnel TCP 片段生成、比对、校验和发布，保留其他 ingress 及回退点。
 * 对应文档: docs/tcp-forwarding.md
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const YAML = require('yaml');
const { isTcp } = require('./TcpListeners');

const BEGIN = '  # BEGIN FLUX GATE TCP';
const END = '  # END FLUX GATE TCP';
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
    return (config.routes || []).filter((route) => isTcp(route) && !route.disabled).map((route) => ({
      hostname: `${route.subdomain}.${config.baseDomain}`, service: `tcp://127.0.0.1:${route.listen_port}`,
    }));
  }

  candidate(original, rules) {
    const beginCount = original.split(BEGIN).length - 1, endCount = original.split(END).length - 1;
    if (beginCount !== endCount || beginCount > 1) throw new Error('Invalid managed TCP markers');
    const without = original.replace(new RegExp(`^${BEGIN}\\r?\\n[\\s\\S]*?^${END}\\r?\\n?`, 'm'), '');
    if (without.includes(BEGIN) || without.includes(END)) throw new Error('Invalid managed TCP section');
    const parsed = YAML.parse(without);
    if (!parsed || !Array.isArray(parsed.ingress) || !/^ingress:\s*\r?\n/m.test(without)) throw new Error('Tunnel ingress must be a block list');
    for (const rule of rules) {
      if (parsed.ingress.some((entry) => entry.hostname === rule.hostname)) {
        throw new Error(`Hostname ${rule.hostname} already belongs to an unmanaged Tunnel route`);
      }
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
      if (!settings.enabled) return { enabled: false, status: 'disabled', rules };
      const original = fs.readFileSync(settings.file, 'utf8');
      const desired = this.candidate(original, rules);
      let receipt;
      try { receipt = JSON.parse(fs.readFileSync(`${settings.file}.flux-gate-applied.json`, 'utf8')); } catch {}
      return { enabled: true, status: desired === original && receipt?.sha256 === hash(original) ? 'applied' : 'pending', rules };
    } catch (error) { return { enabled: true, status: 'error', rules: [], error: error.message }; }
  }

  async apply() {
    if (this.busy) throw Object.assign(new Error('Tunnel publish is already running'), { status: 409 });
    this.busy = true;
    let lock, lockFile, candidateFile;
    try {
      const settings = this.settings();
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
