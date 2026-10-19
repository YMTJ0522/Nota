#!/usr/bin/env bash
# Nota 官网：把安装包更新到最新发布版。
#
#   sudo bash update.sh              # 跟着最新版走
#   sudo bash update.sh 2.7.3        # 钉死某个版本
#
# 干三件事：
#   1. 下载 Nota-Setup-<ver>.exe 到 <站点>/d/setup.exe（覆盖旧文件）
#   2. 重写 <站点>/info.json —— 页面上的文件名、体积、当前版本都读它
#   3. 打一遍自检，确认 /d/setup.exe 真的能下
#
# 页面上的下载按钮是固定路径 /d/setup.exe，不写版本号，
# 所以换完文件用户下一个拿到的就是新版，页面本身一个字都不用改。
set -euo pipefail

REPO="${REPO:-YMTJ0522/Nota}"
ROOT="${ROOT:-/var/www/nota}"
VER="${1:-}"

say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$ROOT" ] || die "站点目录不存在：$ROOT（先跑 install.sh 或 install-python.sh）"
command -v curl >/dev/null || die "没有 curl"

# ── 1. 定版本 ──
if [ -z "$VER" ]; then
  say "问最新发布版是哪个"
  VER="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 \
        | sed 's/.*"v\{0,1\}\([0-9][^"]*\)".*/\1/')"
  [ -n "$VER" ] || die "取不到最新版本号；断网或接口限流的话，直接带上版本号跑：bash update.sh 2.7.3"
fi
say "目标版本：${VER}"

NAME="Nota-Setup-${VER}.exe"
URL="https://github.com/${REPO}/releases/download/v${VER}/${NAME}"

# ── 2. 下载（先落临时文件，成了再替换，别把线上包弄坏） ──
mkdir -p "$ROOT/d"
TMP="$ROOT/d/.setup.new"
say "下载 ${NAME}"
if ! curl -fL --retry 3 --retry-delay 2 -o "$TMP" "$URL"; then
  rm -f "$TMP"
  die "下载失败：${URL}"
fi

# 太小基本就是错误页而不是安装包
SZ=$(stat -c %s "$TMP" 2>/dev/null || stat -f %z "$TMP")
[ "$SZ" -gt 10000000 ] || die "下载到的文件只有 ${SZ} 字节，不像是安装包（发布里是不是没有这个文件名？）"

# Windows 可执行文件以 MZ 开头，顺手确认一下没拿到 HTML
head -c 2 "$TMP" | grep -q "MZ" || die "下载到的不是 exe（开头不是 MZ）"

mv -f "$TMP" "$ROOT/d/setup.exe"
chmod 644 "$ROOT/d/setup.exe"
say "已替换 d/setup.exe（$(awk "BEGIN{printf \"%.0f\", $SZ/1048576}") MB）"

# ── 3. info.json：页面的版本、文件名、体积都从这儿来 ──
cat > "$ROOT/info.json" <<JSON
{
  "version": "${VER}",
  "assets": {
    "setup": { "name": "${NAME}", "size": ${SZ} }
  }
}
JSON
chmod 644 "$ROOT/info.json"
say "info.json 已更新"

# ── 4. 自检 ──
say "自检"
DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -f /etc/nginx/conf.d/nota.conf ]; then
  DOMAIN="$(awk '/server_name/ {print $2; exit}' /etc/nginx/conf.d/nota.conf | tr -d ';')"
elif [ -z "$DOMAIN" ] && [ -f /etc/nginx/sites-available/nota.conf ]; then
  DOMAIN="$(awk '/server_name/ {print $2; exit}' /etc/nginx/sites-available/nota.conf | tr -d ';')"
fi

if [ -n "$DOMAIN" ]; then
  # nginx 版本走域名；零依赖那种直接打本机端口
  for u in "http://127.0.0.1/d/setup.exe" "http://127.0.0.1:8080/d/setup.exe"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${DOMAIN}" "$u" || echo 000)"
    [ "$code" = "200" ] && { echo "    /d/setup.exe  HTTP 200"; break; }
  done
fi

echo
echo "完成。当前版本 ${VER}"
[ -n "$DOMAIN" ] && echo "  页面   http://${DOMAIN}/"
echo "  下载   http://${DOMAIN:-<你的域名>}/d/setup.exe"
echo
echo "想每次发版自动跑，加一条 cron（每天凌晨 4 点对一次）："
echo "  0 4 * * * bash ${ROOT}/../../update.sh >/var/log/nota-update.log 2>&1"
