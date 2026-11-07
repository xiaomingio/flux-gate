#!/usr/bin/env node
/*
 * 文件说明: 从受信网关配置发布受管 HTTP/TCP ingress，复用管理 API 的校验、备份和回退流程。
 * 对应文档: docs/tcp-forwarding.md
 */
const path = require('node:path');
const { createConfigStore } = require('../../src/server');
const TunnelConfig = require('../../src/TunnelConfig');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1]))) {
  console.error('Usage: apply-routes.cjs [--config /absolute/path/to/config.json]');
  process.exitCode = 1;
} else {
  const store = createConfigStore(args[1]);
  new TunnelConfig(store).apply().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}
