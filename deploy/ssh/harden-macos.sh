#!/bin/bash
# 文件说明: 为 macOS 系统 SSH 设置仅公钥认证，保留当前连接并安排独立自动回退。
# 对应文档: docs/tcp-forwarding.md
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || { echo 'macOS only.' >&2; exit 1; }
batch=$(cd "$(dirname "$0")" && pwd -P)
[ -f "$batch/restore-macos.sh" ] && [ -f "$batch/rollback-macos.sh" ]
[ ! -e "$batch/backup-ready" ] || { echo 'This batch was already used; inspect it instead of rerunning.' >&2; exit 1; }
[ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]
login_user=$SUDO_USER
login_uid=$(id -u "$login_user")
dropin=/etc/ssh/sshd_config.d/000-agent-beat-key-only.conf
first=$(awk '!/^[[:space:]]*(#|$)/ { print; exit }' /etc/ssh/sshd_config)
[ "$first" = 'Include /etc/ssh/sshd_config.d/*' ] || { echo 'Unexpected Include ordering; inspect sshd_config before proceeding.' >&2; exit 1; }
/usr/sbin/sshd -t
/bin/launchctl print system/com.openssh.sshd >/dev/null
umask 077
mkdir "$batch/original"
cp -p /etc/ssh/sshd_config "$batch/original/sshd_config.reference"
if [ -e "$dropin" ]; then
  [ -f "$dropin" ] && [ ! -L "$dropin" ]
  cp -p "$dropin" "$batch/original/dropin"
  touch "$batch/original/existed"
fi
printf '%s\n' "$login_uid" > "$batch/login-uid"
printf '%s\n' "$login_user" > "$batch/login-user"
touch "$batch/backup-ready"
label="cc.iplab.ssh-key-only-$(date +%s)"
printf '%s\n' "$label" > "$batch/rollback-label"
cat > "$batch/rollback.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$batch/rollback-macos.sh</string></array>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>$batch/rollback.log</string>
<key>StandardErrorPath</key><string>$batch/rollback.log</string>
</dict></plist>
PLIST
chmod 600 "$batch/rollback.plist"
plutil -lint "$batch/rollback.plist"
/bin/launchctl bootstrap system "$batch/rollback.plist"
/bin/launchctl print "system/$label" >/dev/null
failed() {
  echo 'Validation failed; restoring original SSH configuration.' >&2
  /bin/bash "$batch/restore-macos.sh"
}
trap failed ERR
candidate=$(mktemp /etc/ssh/sshd_config.d/.agent-beat.XXXXXX)
printf '%s\n' '# SSH authentication only; macOS account passwords and Screen Sharing stay unchanged.' \
  'PubkeyAuthentication yes' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' \
  'AuthenticationMethods publickey' > "$candidate"
chown root:wheel "$candidate"
chmod 644 "$candidate"
mv "$candidate" "$dropin"
/usr/sbin/sshd -t
for context in default "user=$login_user,host=localhost,addr=127.0.0.1"; do
  if [ "$context" = default ]; then
    /usr/sbin/sshd -T > "$batch/effective.$context"
  else
    /usr/sbin/sshd -T -C "$context" > "$batch/effective.login"
  fi
 done
for effective in "$batch/effective.default" "$batch/effective.login"; do
  grep -qx 'pubkeyauthentication yes' "$effective"
  grep -qx 'passwordauthentication no' "$effective"
  grep -qx 'kbdinteractiveauthentication no' "$effective"
  grep -qx 'authenticationmethods publickey' "$effective"
done
trap - ERR
echo 'SSH key-only configuration installed. launchd reads it for new connections; no service restart.'
echo 'Keep this terminal open. Open a NEW key login and verify password rejection within 180 seconds.'
echo "After successful verification, confirm: touch '$batch/confirmed'"
echo "Screen Sharing recovery: sudo /bin/bash '$batch/restore-macos.sh'"
