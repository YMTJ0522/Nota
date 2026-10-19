#!/usr/bin/env bash
#
# 零依赖版：不装 nginx、不碰包管理器，只用系统自带的 Python 起一个静态服务。
#
#   sudo bash install-python.sh
#
# 为什么要有这一版：CentOS 7 在 2024 年 6 月停止维护，官方源已经下线，
# `yum install` 什么都装不上（连 metadata 都拉不到）。这台机器要是 CentOS 7，
# 正装 nginx 的路是堵死的，只能靠系统里本来就有的东西。
#
# 代价说清楚：Python 自带的 http server 是**单线程**，同时来两个人下 80MB
# 会排队。当个人官网够用，人多了就该换系统装 nginx（见 README）。
#
set -euo pipefail

DOMAIN="${DOMAIN:-ymtj.hyper99.top}"
REPO="YMTJ0522/Nota"
ROOT="/var/www/nota"
PORT="${PORT:-80}"

say() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m中止：%s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || die "要用 root 跑（sudo bash install-python.sh）"

# ── 1. 找一个能用的 Python ──
say "检查 Python"
if command -v python3 >/dev/null 2>&1; then
  PY="$(command -v python3)"; MOD="http.server"; PYV="$($PY -V 2>&1)"
elif command -v python >/dev/null 2>&1; then
  PY="$(command -v python)"; MOD="SimpleHTTPServer"; PYV="$($PY -V 2>&1)"
else
  die "系统里没有 python，这条路走不了 —— 只能换系统或手动装 Web 服务器"
fi
echo "    用 $PY（$PYV）"

# ── 2. 取最新版本 ──
say "查询最新版本"
VER="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
VER="${VER#v}"
[ -n "$VER" ] || die "取不到版本号 —— 这台机器能连 api.github.com 吗？"
echo "    最新版本：$VER"

# ── 3. 文件 ──
say "下载站点与安装包"
mkdir -p "$ROOT/d" "$ROOT/shots"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/main" -o "$TMP/src.tar.gz" \
  || die "拉取源码包失败"
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC="$TMP/Nota-main"
[ -f "$SRC/deploy/server/public/index.html" ] || die "包里没有服务器版页面"

cp -f "$SRC/deploy/server/public/index.html" "$ROOT/index.html"
cp -f "$SRC/site/icon.png" "$ROOT/icon.png"
cp -f "$SRC"/site/shots/*.png "$ROOT/shots/" 2>/dev/null || true

for kind in Setup Portable; do
  lower="$(echo "$kind" | tr 'A-Z' 'a-z')"
  dst="$ROOT/d/${lower}.exe"
  [ -f "$dst" ] && { echo "    ${lower}.exe 已存在"; continue; }
  curl -fL --retry 2 -o "$dst" \
    "https://github.com/${REPO}/releases/download/v${VER}/Nota-${kind}-${VER}.exe" \
    || die "下载 Nota-${kind}-${VER}.exe 失败"
done
ls -lh "$ROOT/d/"

# ── 4. info.json ──
sz() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }
cat > "$ROOT/info.json" <<JSON
{
  "version": "${VER}",
  "assets": {
    "setup": { "name": "Nota-Setup-${VER}.exe", "size": $(sz "$ROOT/d/setup.exe") },
    "portable": { "name": "Nota-Portable-${VER}.exe", "size": $(sz "$ROOT/d/portable.exe") }
  }
}
JSON

# ── 5. MIME：确保 .exe 被当成二进制下载，而不是在浏览器里显示乱码 ──
if [ -f /etc/mime.types ] && ! grep -qi "x-msdownload.*\bexe\b" /etc/mime.types; then
  echo 'application/x-msdownload	exe dll' >> /etc/mime.types
  echo "    补了一条 exe 的 MIME 映射"
fi

# ── 6. SELinux：CentOS 默认拦着非 httpd 进程绑 80 ──
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  warn "SELinux 是 Enforcing，会拦住这个服务绑 80 端口"
  setenforce 0 2>/dev/null || true
  sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config 2>/dev/null || true
  echo "    已切成 permissive（日志里还会记违规，但不再拦）"
fi

# ── 7. systemd 服务 ──
say "配置开机自启"
cat > /etc/systemd/system/nota.service <<UNIT
[Unit]
Description=Nota site (python static server)
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${PY} -m ${MOD} ${PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable nota >/dev/null 2>&1 || true
systemctl restart nota
sleep 1

# ── 8. 防火墙 ──
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  echo "    firewalld 已放行"
fi

# ── 9. 自检 ──
say "自检"
echo "    服务状态：$(systemctl is-active nota 2>/dev/null || echo 未知)"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMAIN}" "http://127.0.0.1:${PORT}/" || echo 000)"
echo "    首页：HTTP $code"
[ "$code" = "200" ] || warn "首页不是 200，看 journalctl -u nota -n 30"
for k in setup portable; do
  c="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMAIN}" "http://127.0.0.1:${PORT}/d/${k}.exe" || echo 000)"
  echo "    /d/${k}.exe：HTTP $c"
done

cat <<TIP

\033[32m完成\033[0m

  站点   http://${DOMAIN}
  下载   http://${DOMAIN}/d/setup.exe
         http://${DOMAIN}/d/portable.exe

这台机器没有 HTTPS（Python 自带的服务不支持），浏览器会提示「不安全」。
能用，但要正经对外发，还是建议换系统装 nginx + 证书：

  华为云控制台 → 这台机器 → 关机 → 更多 → 切换操作系统 → Ubuntu 22.04
  然后跑 sudo bash install.sh 你的邮箱   （会签 Let's Encrypt）

看下载量（Python 自带的访问日志走 journald，没有单独文件）：

  journalctl -u nota | grep -c 'GET /d/setup.exe'
  journalctl -u nota | grep -c 'GET /d/portable.exe'

TIP
