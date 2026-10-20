#!/usr/bin/env bash
#
# 离线部署：站点文件已经被 scp 到机器上，这里只负责解压 + 起服务。
#
#   sudo bash install-local.sh /root/nota-site-2.7.3.tgz
#
# 跟 install-python.sh 的区别只有一个：不联网。
# 那版要 curl api.github.com 查版本、再从 codeload 拉源码 —— 机器在境内，
# 这一步能不能过全看运气。这版所有文件都在包里，服务器只做本地动作。
#
# 为什么不用 nginx：CentOS 7 在 2024-06 停止维护，官方源已下线，
# yum 连 metadata 都拉不到。只能靠系统自带的东西，所以是 Python 的 http.server。
# 代价照说：单线程，两个人同时下 80MB 会排队；没有 HTTPS。
#
set -euo pipefail

BUNDLE="${1:-}"
DOMAIN="${DOMAIN:-ymtj.hyper99.top}"
ROOT="${ROOT:-/var/www/nota}"
PORT="${PORT:-80}"

say() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m中止：%s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || die "要用 root 跑：sudo bash install-local.sh <包>"
[ -n "$BUNDLE" ] || die "用法：sudo bash install-local.sh /root/nota-site-x.y.z.tgz"
[ -f "$BUNDLE" ] || die "找不到 $BUNDLE"

# ── 1. Python ──
say "检查 Python"
if command -v python3 >/dev/null 2>&1; then
  PY="$(command -v python3)"; MOD="http.server"
elif command -v python >/dev/null 2>&1; then
  PY="$(command -v python)"; MOD="SimpleHTTPServer"
else
  die "系统里没有 python，这条路走不了"
fi
echo "    $PY（$("$PY" -V 2>&1)），模块 $MOD"

# ── 2. 端口占用 ──
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  warn "端口 ${PORT} 已经被别的进程占了："
  ss -ltnp 2>/dev/null | grep ":${PORT} " || true
  die "先停掉它，或者用 PORT=8080 换端口"
fi

# ── 3. 解压 ──
say "解压到 $ROOT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar -xzf "$BUNDLE" -C "$TMP"
[ -f "$TMP/site/index.html" ] || die "包里没有 site/index.html"
[ -f "$TMP/d/setup.exe" ] || warn "包里没有 d/setup.exe，下载按钮会 404"

mkdir -p "$ROOT"
# 旧的 shots 先清掉：换过名的截图留着会被一起发布出去
rm -rf "$ROOT/shots"
cp -f "$TMP/site/index.html" "$ROOT/index.html"
cp -f "$TMP/site/icon.png" "$ROOT/icon.png" 2>/dev/null || true
mkdir -p "$ROOT/shots"
cp -f "$TMP"/site/shots/*.png "$ROOT/shots/" 2>/dev/null || true
mkdir -p "$ROOT/d"
[ -f "$TMP/d/setup.exe" ] && cp -f "$TMP/d/setup.exe" "$ROOT/d/setup.exe"
cp -f "$TMP/info.json" "$ROOT/info.json" 2>/dev/null || true

VER="$(cat "$TMP/VERSION" 2>/dev/null || echo '')"
echo "    版本 ${VER:-未知}"
ls -lh "$ROOT/d/"

# ── 4. MIME：让 .exe 直接下载，而不是在浏览器里当文本打开 ──
if [ -f /etc/mime.types ] && ! grep -qiE 'x-msdownload[[:space:]].*\bexe\b' /etc/mime.types; then
  printf 'application/x-msdownload\texe dll\n' >> /etc/mime.types
  echo "    补了一条 exe 的 MIME 映射"
fi

# ── 5. SELinux：CentOS 默认拦着非 httpd 进程绑 80 ──
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  warn "SELinux 是 Enforcing，会拦住这个服务绑 ${PORT}"
  setenforce 0 2>/dev/null || true
  sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config 2>/dev/null || true
  echo "    已切成 permissive"
fi

# ── 6. systemd ──
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

# ── 7. 防火墙 ──
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  echo "    firewalld 已放行"
fi

# ── 8. 自检 ──
say "自检"
echo "    服务：$(systemctl is-active nota 2>/dev/null || echo 未知)"
c1="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || echo 000)"
echo "    首页      HTTP $c1"
c2="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/d/setup.exe" || echo 000)"
echo "    /d/setup.exe  HTTP $c2"
c3="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/info.json" || echo 000)"
echo "    /info.json    HTTP $c3"
[ "$c1" = "200" ] || warn "首页不是 200，看 journalctl -u nota -n 30"

cat <<TIP

\033[32m完成\033[0m

  站点   http://${DOMAIN}/
  下载   http://${DOMAIN}/d/setup.exe

没有 HTTPS（Python 自带服务不支持），浏览器会提示「不安全」。
要看访问日志：journalctl -u nota | grep 'GET /d/setup.exe'

TIP
