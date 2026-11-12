#!/usr/bin/env bash
# ============================================================================
#  ARAL URANIUM — Relay Builder (aral-relay)
#  Free & open-source · part of the ARAL URANIUM Panel project (t.me/AralDev)
#
#  Builds a private SOCKS5 "relay" on any Linux VPS with GOST + systemd so the
#  panel's per-user Exit Locations (لوکیشن‌های خروجی) can chain through it.
#  Menu: install/update · uninstall · pause · resume · traffic statistics
#
#  Usage:  sudo bash aral-relay.sh
# ============================================================================
set -u

GOLD='\033[1;33m'; RED='\033[1;31m'; GRN='\033[1;32m'; RST='\033[0m'
GOST_VERSION="3.0.0-rc10"
GOST_URL="https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_linux_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/;s/armv7l/armv7/').tar.gz"
SERVICE=/etc/systemd/system/gost.service
BIN=/usr/local/bin/gost
STATS_MARK=aral-uranium-relay

fail() { echo -e "${RED}[!] $1${RST}"; exit 1; }
ok()   { echo -e "${GRN}[+] $1${RST}"; }

[ "$(id -u)" -eq 0 ] || fail "This script must be run as root (sudo bash aral-relay.sh)"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"

open_firewall() {
  local port="$1"
  if command -v ufw >/dev/null 2>&1; then
    ufw allow "${port}/tcp" >/dev/null 2>&1 || true
  elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --zone=public --add-port="${port}/tcp" --permanent >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi
  iptables -I INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || true
  return 0
}

install_or_update() {
  echo -e "${GOLD}[*] ARAL URANIUM relay installer (GOST ${GOST_VERSION})${RST}"
  read -r -p "Listen port  [443]: " PORT; PORT=${PORT:-443}
  read -r -p "Username     [aral]: " USER_; USER_=${USER_:-aral}
  read -r -p "Password     [random]: " PASS; PASS=${PASS:-$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)}
  case "$PORT" in ''|*[!0-9]*) fail "Invalid port";; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "Port out of range"

  echo -e "${GOLD}[*] Downloading gost…${RST}"
  curl -fsSL --retry 3 -o /tmp/gost.tgz "$GOST_URL" || fail "Download failed — check network"
  tar -xzf /tmp/gost.tgz -C /tmp gost || fail "Extract failed"
  install -m 0755 /tmp/gost "$BIN" || fail "Install failed"
  rm -f /tmp/gost.tgz /tmp/gost

  cat > "$SERVICE" <<EOF
[Unit]
Description=ARAL URANIUM Relay (GOST SOCKS5)
Documentation=https://t.me/AralDev
After=network.target nss-lookup.target

[Service]
Type=simple
ExecStart=${BIN} -L "socks5+tls://${USER_}:${PASS}@:${PORT}"
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable gost >/dev/null 2>&1
  systemctl restart gost
  open_firewall "$PORT"

  # small BBR/sysctl tuning
  cat > /etc/sysctl.d/99-aral-relay.conf <<EOF
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.ipv4.tcp_congestion_control=bbr
net.core.default_qdisc=fq
EOF
  sysctl --system >/dev/null 2>&1 || true

  IP=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  ok "Relay is UP"
  echo -e "${GOLD}──────────────────────────────────────────────${RST}"
  echo -e "  Address : ${GRN}socks5://${USER_}:${PASS}@${IP}:${PORT}${RST}"
  echo -e "  Paste this into ARAL URANIUM → Subscribers → Edit → لوکیشن و IP (Locations)"
  echo -e "  Service : systemctl {status|stop|start} gost"
  echo -e "${GOLD}──────────────────────────────────────────────${RST}"
}

uninstall_all() {
  echo -e "${GOLD}[*] Removing ARAL URANIUM relay…${RST}"
  systemctl stop gost 2>/dev/null || true
  systemctl disable gost 2>/dev/null || true
  PORT_REMOVED=$(grep -oP '(?<=@:)\d+' "$SERVICE" 2>/dev/null || true)
  if [ -n "${PORT_REMOVED:-}" ]; then
    if command -v ufw >/dev/null 2>&1; then ufw delete allow "${PORT_REMOVED}/tcp" 2>/dev/null || true; fi
    iptables -D INPUT -p tcp --dport "$PORT_REMOVED" -j ACCEPT 2>/dev/null || true
  fi
  rm -f "$SERVICE" "$BIN" /etc/sysctl.d/99-aral-relay.conf
  systemctl daemon-reload
  ok "Uninstalled"
}

show_stats() {
  echo -e "${GOLD}[*] Traffic statistics (iptables counters, marker: ${STATS_MARK})${RST}"
  iptables -L INPUT -v -n 2>/dev/null | grep -E "dpt:(443|8443|2053|2083|2087|2096|1080)" || echo "  (no per-port counters yet — stats start counting after install/next restart)"
  echo
  echo -e "${GOLD}Service:${RST} $(systemctl is-active gost 2>/dev/null || echo 'not installed') · $(systemctl is-enabled gost 2>/dev/null || echo '-')"
  journalctl -u gost --no-pager -n 6 2>/dev/null | tail -6 || true
}

while true; do
  echo
  echo -e "${GOLD}══════════════════════════════════════════════${RST}"
  echo -e "${GOLD}   ARAL URANIUM · RELAY BUILDER (SOCKS5/GOST)${RST}"
  echo -e "${GOLD}══════════════════════════════════════════════${RST}"
  echo "  1) Install / Update relay"
  echo "  2) Uninstall & remove"
  echo "  3) Pause (temporary stop)"
  echo "  4) Resume (start)"
  echo "  5) Traffic statistics & service status"
  echo "  6) Exit"
  read -r -p "Choice [1-6]: " choice </dev/tty || exit 0
  case "$choice" in
    1) install_or_update ;;
    2) uninstall_all ;;
    3) systemctl stop gost && ok "Paused" || echo -e "${RED}[!] stop failed${RST}" ;;
    4) systemctl start gost && ok "Resumed" || echo -e "${RED}[!] start failed${RST}" ;;
    5) show_stats ;;
    6) exit 0 ;;
    *) echo -e "${RED}[!] invalid choice${RST}" ;;
  esac
  sleep 1
done
