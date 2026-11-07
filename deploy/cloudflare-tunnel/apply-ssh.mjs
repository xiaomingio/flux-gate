#!/usr/bin/env node
/*
 * 文件说明: 在既有本地管理 Tunnel 配置中加入独立 SSH ingress，保留 HTTP 规则并备份。
 * 对应文档: docs/tcp-forwarding.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const configFile = path.join(os.homedir(), '.cloudflared/config.yml');
const route = JSON.parse(fs.readFileSync(new URL('./ssh.json', import.meta.url), 'utf8'));
if (process.argv.slice(2).join(' ') !== '--key-only-verified') {
  throw new Error('Verify a fresh SSH key login and rejected password authentication, then pass --key-only-verified.');
}
if (!/^[a-z0-9.-]+$/.test(route.hostname) || route.service !== 'ssh://127.0.0.1:22') {
  throw new Error('Invalid managed SSH route');
}
const original = fs.readFileSync(configFile, 'utf8');
const hostnameLines = [...original.matchAll(/^([ ]*)-[ ]*hostname:[ ]*(["']?)([^\n"']+)\2[ ]*$/gm)];
const existing = hostnameLines.find((match) => match[3] === route.hostname);
if (existing) {
  const following = original.slice(existing.index + existing[0].length);
  if (!new RegExp(`^\\s*service: ["']?${route.service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*(?:\\n|$)`).test(following)) {
    throw new Error('Existing SSH hostname has a different service; inspect instead of replacing it');
  }
  console.log('SSH ingress already matches; no change.');
  process.exit(0);
}
const first = hostnameLines[0];
if (!first || !original.includes('\ningress:\n')) throw new Error('Unsupported ingress layout; inspect configuration');
const indent = first[1];
const updated = original.slice(0, first.index) + `${indent}- hostname: ${route.hostname}\n${indent}  service: ${route.service}\n` + original.slice(first.index);
const candidate = `${configFile}.${crypto.randomUUID()}.tmp`;
fs.writeFileSync(candidate, updated, { mode: 0o600, flag: 'wx' });
try {
  execFileSync('cloudflared', ['--config', candidate, 'tunnel', 'ingress', 'validate'], { stdio: 'inherit' });
  execFileSync('cloudflared', ['--config', candidate, 'tunnel', 'ingress', 'rule', `https://${route.hostname}`], { stdio: 'inherit' });
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).replace(/\D/g, '');
  const backup = path.join(os.homedir(), 'backups/cloudflare-tunnel/config', `${stamp}-${crypto.randomUUID()}.yml`);
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  fs.writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
  if (fs.readFileSync(configFile, 'utf8') !== original) throw new Error('Tunnel config changed concurrently; nothing replaced');
  fs.renameSync(candidate, configFile);
  console.log(`SSH ingress saved; backup: ${backup}`);
  console.log('Restart only cloudflare-tunnel, then verify public SSH and both existing HTTP entries.');
} finally {
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
