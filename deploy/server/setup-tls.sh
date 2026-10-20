#!/usr/bin/env bash
#
# 给站点签 Let's Encrypt 证书。
#
#   bash setup-tls.sh                 # 第一次：申请 + 安装 + 加续期任务
#   bash setup-tls.sh --renew         # 只续期
#
# 前提：acme.sh 已经在本目录（服务器出网到 raw.githubusercontent 不通，
# 所以是本地下载了再传上来的）。域名必须已经指向这台机器，且 80 端口
# 能从公网访问 —— 用的是 webroot 验证，站点不用停。
#
set -euo pipefail

DOMAIN="${DOMAIN:-ymtj.hyper99.top}"
WEBROOT="${WEBROOT:-/var/www/nota}"
EMAIL="${EMAIL:-admin@${DOMAIN#*.}}"
ACME="${ACME:-/root/acme.sh}"
CERTDIR=/etc/nota

say() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m中止：%s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || die "要用 root 跑"
[ -f "$ACME" ] || die "找不到 $ACME（acme.sh 要先传上来）"

export HOME=/root
ACME_HOME=/root/.acme.sh

say "准备 acme.sh"
mkdir -p "$ACME_HOME/.well-known" 2>/dev/null || true
if [ ! -f "$ACME_HOME/acme.sh" ]; then
  cp -f "$ACME" "$ACME_HOME/acme.sh"
  chmod +x "$ACME_HOME/acme.sh"
fi
sh "$ACME_HOME/acme.sh" --version

if [ "${1:-}" = "--renew" ]; then
  say "续期"
  sh "$ACME_HOME/acme.sh" --cron --home "$ACME_HOME"
  exit 0
fi

say "申请证书（webroot 验证，站点不停）"
# webroot 里要真的有 .well-known 目录，acme.sh 会往里写挑战文件
mkdir -p "$WEBROOT/.well-known/acme-challenge"
sh "$ACME_HOME/acme.sh" --issue -d "$DOMAIN" \
  --webroot "$WEBROOT" \
  --server letsencrypt \
  --accountemail "$EMAIL" \
  --keylength ec-256 \
  --log /root/acme-issue.log || {
    echo
    echo "签发失败，最后 30 行日志："
    tail -30 /root/acme-issue.log || true
    die "看上面的原因（常见：80 不通、域名没指过来、Let's Encrypt 限流）"
  }

say "安装证书到 $CERTDIR"
mkdir -p "$CERTDIR"
sh "$ACME_HOME/acme.sh" --install-cert -d "$DOMAIN" --ecc \
  --key-file       "$CERTDIR/key.pem" \
  --fullchain-file "$CERTDIR/fullchain.pem" \
  --reloadcmd      "systemctl restart nota"

say "加续期任务"
CRON="17 3 * * * \"$ACME_HOME\"/acme.sh --cron --home \"$ACME_HOME\" > /dev/null"
if ! crontab -l 2>/dev/null | grep -q "acme.sh --cron"; then
  ( crontab -l 2>/dev/null; echo "$CRON" ) | crontab -
  echo "    已加：每天 03:17 检查一次"
else
  echo "    已经有了"
fi

say "证书信息"
openssl x509 -in "$CERTDIR/fullchain.pem" -noout -subject -issuer -dates || true

cat <<TIP

\033[32m完成\033[0m

证书：$CERTDIR/fullchain.pem
私钥：$CERTDIR/key.pem
站点服务看到这两个文件就会自己起 443（serve.py），没有就只跑 80。

TIP
