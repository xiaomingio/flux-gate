/*
 * 文件说明: 保存最近的非秘密操作回执，让 Tunnel 重载断线后可只读确认同一操作。
 * 对应文档: docs/tcp-forwarding.md
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const digest = (config) => crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');

class OperationReceipts {
  constructor(file) {
    this.file = file;
    this.records = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(saved.operations)) throw new Error('Invalid operation receipts');
      for (const record of saved.operations) this.records.set(record.id, record);
      let interrupted = false;
      for (const record of this.records.values()) {
        if (['queued', 'running'].includes(record.status)) {
          record.status = 'unknown'; record.error = 'Gateway restarted before this operation was confirmed; inspect the current route state'; interrupted = true;
        }
      }
      if (interrupted) this.save();
    } catch (error) {
      if (error.code !== 'ENOENT') this.unavailable = true;
    }
  }

  save() {
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ operations: [...this.records.values()] }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  create(id = crypto.randomUUID()) {
    if (this.unavailable) throw Object.assign(new Error('Operation receipts are unreadable; inspect the runtime file before changing routes'), { status: 503 });
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw Object.assign(new Error('Invalid operation identifier'), { status: 400 });
    if (this.records.has(id)) throw Object.assign(new Error('Operation identifier already exists; read its receipt instead of repeating the write'), { status: 409, operationId: id });
    while (this.records.size >= 20) {
      const completed = [...this.records.values()].find((record) => !['queued', 'running'].includes(record.status));
      if (!completed) throw Object.assign(new Error('Too many pending operations'), { status: 429 });
      this.records.delete(completed.id);
    }
    this.records.set(id, { id, revision: crypto.randomUUID(), status: 'queued', updated_at: new Date().toISOString() });
    try { this.save(); } catch { this.records.delete(id); throw new Error('Operation receipt could not be saved; nothing changed'); }
    return id;
  }

  update(id, status, config, error) {
    const record = this.records.get(id);
    Object.assign(record, { status, updated_at: new Date().toISOString() });
    if (config) record.config_sha256 = digest(config);
    if (error) record.error = error;
    this.save();
  }

  get(id, config, tunnel) {
    const record = this.records.get(id);
    if (!record) return null;
    const current = record.config_sha256 === digest(config) &&
      (record.status === 'local_only' ? tunnel.status === 'disabled' : tunnel.status === 'applied');
    const rollbackConfirmed = record.status === 'rolled_back' && record.config_sha256 === digest(config) && ['applied', 'disabled'].includes(tunnel.status);
    return { id: record.id, revision: record.revision, status: record.status, updated_at: record.updated_at, current,
      rollback_confirmed: rollbackConfirmed, ...(record.error && { error: record.error }) };
  }
}

module.exports = OperationReceipts;
