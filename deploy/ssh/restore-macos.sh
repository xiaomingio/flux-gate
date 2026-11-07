#!/bin/bash
# 文件说明: 还原同一批次的 SSH 认证配置；可从 Mac mini 屏幕共享终端执行。
# 对应文档: docs/tcp-forwarding.md
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
batch=$(cd "$(dirname "$0")" && pwd -P)
[ -f "$batch/backup-ready" ] || { echo 'No configuration has been changed by this batch.'; exit 0; }
dropin=/etc/ssh/sshd_config.d/000-agent-beat-key-only.conf
if [ -f "$batch/original/existed" ]; then
  candidate=$(mktemp /etc/ssh/sshd_config.d/.agent-beat-restore.XXXXXX)
  cp -p "$batch/original/dropin" "$candidate"
  mv "$candidate" "$dropin"
else
  rm -f "$dropin"
fi
/usr/sbin/sshd -t
/usr/sbin/sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|authenticationmethods) '
touch "$batch/restored"
echo 'Original SSH authentication restored. launchd applies it to new connections; no service restart.'
