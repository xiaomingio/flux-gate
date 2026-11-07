#!/bin/bash
# 文件说明: 由独立 root launchd 作业在超时且未确认新连接时恢复 SSH 配置。
# 对应文档: docs/tcp-forwarding.md
set -euo pipefail
batch=$(cd "$(dirname "$0")" && pwd -P)
for ((attempt = 0; attempt < 180; attempt++)); do
  if [ -f "$batch/confirmed" ] && [ "$(stat -f %u "$batch/confirmed")" = "$(cat "$batch/login-uid")" ]; then
    echo 'New key login confirmed; automatic rollback cancelled.'
    touch "$batch/rollback-cancelled"
    exit 0
  fi
  [ ! -e "$batch/restored" ] || exit 0
  sleep 1
done
/bin/bash "$batch/restore-macos.sh"
