#!/usr/bin/env bash
#
# 把 Nota 官网 + 两个安装包架到一台 Linux 服务器上。
#
#   bash install.sh 你的邮箱@example.com
#
# 邮箱只用于给 Let's Encrypt 登记证书，会收到到期提醒。不填就跳过 HTTPS，
# 先只跑 HTTP（能访问，但浏览器会提示不安全）。
#
# 为什么不用 Cloudflare：这台机器的域名解析在别人账号里，改不了；
# 而 A 记录已经指向本机，所以只要本机有服务，域名就活了。
#
# 前置（脚本改不了，得你在云平台控制台点）：
#   安全组 / 防火墙放行 80 和 443 —— 否则外网进不来，证书也签不下来。
#
set -euo pipefail

DOMAIN="${DOMAIN:-ymtj.hyper99.top}"
REPO="YMTJ0522/Nota"
ROOT="/var/www/nota"
EMAIL="${1:-}"

say() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m中止：%s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || die "要用 root 跑（sudo bash install.sh 你的邮箱）"

# ── 1. 装 nginx ──
say "安装 nginx"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx curl ca-certificates >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y nginx curl ca-certificates >/dev/null
elif command -v yum >/dev/null 2>&1; then
  yum install -y nginx curl ca-certificates >/dev/null
else
  die "认不出包管理器（apt/dnf/yum 都没有）"
fi
command -v nginx >/dev/null || die "nginx 没装上"

# ── 2. 取最新版本号 ──
say "查询最新版本"
VER="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
VER="${VER#v}"
[ -n "$VER" ] || die "取不到最新版本号（服务器能连 api.github.com 吗？）"
echo "    最新版本：$VER"

# ── 3. 静态站 ──
say "下载站点文件"
mkdir -p "$ROOT/dl" "$ROOT/shots"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/main" -o "$TMP/src.tar.gz"
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC="$TMP/Nota-main"

[ -f "$SRC/deploy/server/public/index.html" ] || die "压缩包里没有 deploy/server/public/index.html"
install -m 644 "$SRC/deploy/server/public/index.html" "$ROOT/index.html"
install -m 644 "$SRC/site/icon.png" "$ROOT/icon.png"
cp -f "$SRC"/site/shots/*.png "$ROOT/shots/" 2>/dev/null || true
echo "    页面与截图就位"

# ── 4. 安装包 ──
say "下载安装包（约 150 MB，看带宽）"
for kind in Setup; do
  dst="$ROOT/dl/Nota-${kind}.exe"
  if [ -f "$dst" ]; then
    echo "    Nota-${kind}.exe 已存在，跳过"
    continue
  fi
  curl -fL --retry 2 -o "$dst" \
    "https://github.com/${REPO}/releases/download/v${VER}/Nota-${kind}-${VER}.exe" \
    || die "下载 Nota-${kind}-${VER}.exe 失败"
done
ls -lh "$ROOT/dl/"

# ── 5. info.json：页面上显示的版本与体积 ──
sz() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }
cat > "$ROOT/info.json" <<JSON
{
  "version": "${VER}",
  "assets": {
    "setup": { "name": "Nota-Setup-${VER}.exe", "size": $(sz "$ROOT/dl/Nota-Setup.exe") }
  }
}
JSON

# ── 6. nginx 配置 ──
say "写 nginx 配置"
CONF_DIR="/etc/nginx/conf.d"
[ -d /etc/nginx/sites-available ] && CONF_DIR="/etc/nginx/sites-available"

cat > "$CONF_DIR/nota.conf" <<NGINX
# Nota 官网。下载走本机文件，access.log 就是下载记录。
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    root ${ROOT};
    index index.html;

    # 下载入口：别名到实际文件，文件名带版本，浏览器存盘时看得出来
    location = /d/setup {
        alias ${ROOT}/dl/Nota-Setup.exe;
        default_type application/octet-stream;
        add_header Content-Disposition 'attachment; filename="Nota-Setup-${VER}.exe"';
    }
    # 版本信息给页面脚本读，别让它去问 GitHub
    location = /info.json {
        default_type application/json;
        add_header Cache-Control "no-cache";
    }

    location ~* \.(png|jpg|jpeg|svg|webp|woff2)$ {
        expires 7d;
        add_header Cache-Control "public";
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
NGINX

if [ "$CONF_DIR" = "/etc/nginx/sites-available" ]; then
  ln -sf "$CONF_DIR/nota.conf" /etc/nginx/sites-enabled/nota.conf
  [ -e /etc/nginx/sites-enabled/default ] && rm -f /etc/nginx/sites-enabled/default
fi

nginx -t || die "nginx 配置没过，看上面的报错"

# ── 7. 防火墙（只放行，不动别的规则）──
say "放行 80 / 443"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
  echo "    ufw 已放行"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null || true
  firewall-cmd --permanent --add-service=https >/dev/null || true
  firewall-cmd --reload >/dev/null || true
  echo "    firewalld 已放行"
else
  echo "    没检测到本机防火墙（云平台安全组仍需你自己放行）"
fi

systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx
echo "    nginx 已启动"

# ── 8. HTTPS ──
if [ -n "$EMAIL" ]; then
  say "申请证书（Let's Encrypt）"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  else
    dnf install -y certbot python3-certbot-nginx >/dev/null 2>&1 || yum install -y certbot python3-certbot-nginx >/dev/null 2>&1 || true
  fi
  if command -v certbot >/dev/null 2>&1; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
      || warn "证书没签下来。多半是 80 端口外网进不来(云平台安全组)，放行后重跑: certbot --nginx -d $DOMAIN"
  else
    warn "certbot 没装上，先跑 HTTP；想上 HTTPS 手动装一下再签"
  fi
else
  warn "没给邮箱，跳过 HTTPS。访问 http://$DOMAIN 能通之后，再跑一次带邮箱的"
fi

# ── 9. 自检 ──
say "自检"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMAIN}" http://127.0.0.1/ || echo 000)"
echo "    本机访问首页：HTTP $code"
[ "$code" = "200" ] || warn "首页不是 200，检查 $ROOT/index.html 在不在"
for k in setup; do
  c="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMAIN}" "http://127.0.0.1/d/$k" || echo 000)"
  echo "    /d/$k：HTTP $c"
done

cat <<TIP

\033[32m完成\033[0m

  站点   http://${DOMAIN}
  下载   http://${DOMAIN}/d/setup

如果浏览器打不开，但上面「本机访问」是 200，
那就是云平台安全组没放行 80/443 —— 那个只能在网页控制台点。

看下载量：

  grep -c '"GET /d/setup' /var/log/nginx/access.log

（logrotate 会轮转，历史量看 access.log.1 等）

TIP
