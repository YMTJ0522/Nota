#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nota 后台：登录、改密、下载统计。挂在 serve.py 上跑，不额外起进程。

为什么后台没放在 Cloudflare Worker 上（那边已经写好了）：
域名解析在这台机器上，Worker 就算部署了也收不到 /admin 这条路径。
与其让官网留个 404，不如把同一套页面搬到自己服务器 —— 页面和接口的
路径、字段全都跟 Worker 那版一致（/admin、/api/login、/api/stats…），
将来真迁到 Worker 上，前端一个字都不用改。

数据落在同一个 SQLite 文件里：
    admin            单行，账号 + 密码哈希 + 版本号（改密后旧会话立即失效）
    downloads        每次下载一行；day 按东八区切，统计直接按天分组
    login_attempts   按 IP 哈希记连错次数，连错 5 次锁 15 分钟

几点实现上的注意：

1. **不能用 ON CONFLICT DO UPDATE**。这台是 CentOS 7，Python 3.6 链接的是
   系统自带的 SQLite 3.7.17，upsert 语法 3.24 才有 —— 用了会在登录接口里
   抛 OperationalError，表现是「密码对了也进不去」。一律用 INSERT OR REPLACE。
2. **密码走 PBKDF2-HMAC-SHA256**，跟 Worker 那边同一套参数，将来迁移不用重设。
3. **会话是 HMAC 签名的 cookie**，密钥放 /etc/nota/session.key（首次运行自动生成）。
   cookie 里带 pwd_ver，改一次密码，别处开着的后台立刻失联。
4. 所有写操作都要求同源（比对 Origin 与 Host），配合 SameSite=Lax。
"""
import base64
import hashlib
import hmac
import html
import json
import os
import sqlite3
import time
import urllib.request

try:
    import ssl as _ssl
except ImportError:  # pragma: no cover
    _ssl = None

COOKIE = 'nota_sess'
SESSION_DAYS = 7
MAX_FAILS = 5
LOCK_SEC = 15 * 60
PBKDF2_ROUNDS = 120000
DEFAULT_USER = 'admin'
DEFAULT_PASS = 'admin123'
REPO = 'YMTJ0522/Nota'

TZ_OFFSET = 8 * 3600  # 东八区。服务器是 UTC，直接用 UTC 切日会差八小时


# ── 小工具 ────────────────────────────────────────────────

def day_key(ts=None):
    ts = time.time() if ts is None else ts
    return time.strftime('%Y-%m-%d', time.gmtime(ts + TZ_OFFSET))


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def unb64(text):
    pad = '=' * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def pbkdf2(password, salt_hex):
    return hashlib.pbkdf2_hmac(
        'sha256', password.encode('utf-8'), bytes.fromhex(salt_hex), PBKDF2_ROUNDS
    ).hex()


def new_salt():
    return os.urandom(16).hex()


# ── 页面 ──────────────────────────────────────────────────
# 配色与官网同一套（纸白 / 墨色 / 深绿），后台和官网看着像一件东西。

CSS = """
*{box-sizing:border-box}
:root{
  --paper:#faf9f5;--card:#fff;--ink:#1f1e1a;--ink2:#55534e;--ink3:#8d897e;
  --line:#e7e3d9;--accent:#2f6f52;--accent2:#245842;--soft:#e9f1ec;
  --font:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,Consolas,monospace;
}
html,body{margin:0;height:100%}
body{background:var(--paper);color:var(--ink);font-family:var(--font);font-size:14px;
  -webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;border:none;background:none;cursor:pointer;padding:0}
input{font:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
header.top{background:var(--card);border-bottom:1px solid var(--line)}
header.top .wrap{height:60px;display:flex;align-items:center;gap:10px}
.mark{width:24px;height:24px;border-radius:7px;background:var(--accent);color:#fff;
  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}
.brand{font-size:13px;color:var(--ink2);font-weight:500}
.spacer{flex:1}
.ghost{height:30px;padding:0 12px;border-radius:9px;color:var(--ink2);font-size:12.5px}
.ghost:hover{background:var(--paper);color:var(--ink)}
.solid{height:30px;padding:0 12px;border-radius:9px;background:var(--accent);color:#fff;
  font-size:12.5px;font-weight:500}
.solid:hover{background:var(--accent2)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px}
h1{font-size:19px;margin:0}
h2{font-size:13px;margin:0 0 10px;color:var(--ink2);font-weight:600}
.muted{color:var(--ink3);font-size:12px}
main{padding:24px 0 60px}

/* 表单与按钮：登录页和后台的改密弹窗都用这一套。
   这几个类本来只写在登录页的 style 里，结果后台弹窗里的输入框和保存按钮
   全退化成浏览器默认样式 —— 两页共用的东西必须放在共用的这一段。 */
label{display:block;font-size:12px;color:var(--ink2);margin-bottom:6px}
.field{height:38px;border-radius:9px;background:#f7f5ef;border:1px solid transparent;
  display:flex;align-items:center;padding:0 12px;margin-bottom:14px}
.field:focus-within{border-color:var(--accent);background:#fff}
.field input{flex:1;min-width:0;border:none;outline:none;background:none;font-size:13px;color:var(--ink)}
.btn{width:100%;height:40px;border-radius:10px;background:var(--accent);color:#fff;
  font-size:13px;font-weight:600;margin-top:8px}
.btn:hover{background:var(--accent2)}
.btn:disabled{opacity:.6;cursor:default}
"""

MARK = '<span class="mark">N</span>'

LOGIN_CSS = """
body{display:flex;flex-direction:column}
.center{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
.box{width:380px;max-width:100%;padding:26px;border-radius:16px;background:var(--card);
  border:1px solid var(--line);box-shadow:0 2px 6px rgb(50 45 32/.06),0 36px 80px -30px rgb(50 45 32/.25)}
.box h1{font-size:20px;margin-bottom:6px}
.say{margin:0 0 20px;font-size:12px;color:var(--ink3);line-height:1.7}
.err{background:#fdf0ec;color:#a3402a;border-radius:9px;padding:8px 10px;font-size:12px;
  margin-bottom:14px}
.foot{margin:16px 0 0;font-size:11px;color:#b8b3a6;line-height:1.7}
"""

LOGIN_JS = """
document.getElementById('f').addEventListener('submit', async function (e) {
  e.preventDefault();
  var btn = this.querySelector('.btn');
  btn.disabled = true;
  var fd = new FormData(this);
  var res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') })
  });
  if (res.ok) { location.href = '/admin'; return; }
  var data = {};
  try { data = await res.json(); } catch (_) {}
  var box = document.querySelector('.err');
  if (!box) {
    box = document.createElement('div');
    box.className = 'err';
    document.querySelector('.say').after(box);
  }
  box.textContent = data.error || '登录失败';
  btn.disabled = false;
});
"""

ADMIN_CSS = """
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0 18px}
.kpi{padding:16px;border-radius:14px}
.kpi .k{font-size:12px;color:var(--ink3)}
.kpi .v{font-size:30px;font-weight:700;margin-top:6px;letter-spacing:-.02em}
.kpi .s{font-size:11px;color:var(--ink3);margin-top:4px}
.grid{display:grid;grid-template-columns:1fr 360px;gap:14px}
.pad{padding:16px}
.bars{display:flex;align-items:flex-end;gap:5px;height:140px;margin-top:6px}
.bars i{flex:1;background:#c9dcd1;border-radius:3px 3px 0 0;min-height:2px}
.bars i.today{background:var(--accent)}
.axis{display:flex;justify-content:space-between;font-size:10px;color:#b8b3a6;margin-top:6px}
.row{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid #f0ede5;font-size:12.5px}
.row:first-of-type{border-top:none}
.row .n{flex:1;color:var(--ink)}
.row .v{font-family:var(--mono);color:var(--ink)}
.row .v.lead{color:var(--accent);font-weight:600}
.bar{height:8px;border-radius:5px;background:var(--soft);overflow:hidden;display:flex}
.bar span{display:block;height:8px}
.tip{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--soft);
  font-size:11.5px;color:var(--accent2);line-height:1.7}
dialog{border:none;border-radius:16px;padding:0;background:var(--card);color:var(--ink);
  box-shadow:0 2px 6px rgb(50 45 32/.06),0 36px 80px -30px rgb(50 45 32/.3)}
dialog::backdrop{background:rgb(20 18 14/.45)}
dialog .pad{width:360px}
dialog h2{color:var(--ink);font-size:14px}
dialog .field{margin-bottom:12px}
@media(max-width:900px){.kpis{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}}
"""

ADMIN_JS = """
function $(s){return document.querySelector(s)}
function put(id,v){var e=$(id); if(e) e.textContent=v}

fetch('/api/stats').then(function(r){return r.ok?r.json():null}).then(function(d){
  if(!d){location.href='/admin';return}
  put('#kTotal', d.total)
  put('#kTotalSub', '安装版 ' + d.byAsset.setup + ' · 免安装 ' + d.byAsset.portable)
  put('#kToday', d.today)
  put('#k7', d.last7)
  put('#k7Sub', '前一天 ' + d.yesterday)

  var max = 1
  d.series.forEach(function(p){ if(p[1] > max) max = p[1] })
  var bars = $('#bars'); bars.innerHTML = ''
  d.series.forEach(function(p, i){
    var b = document.createElement('i')
    b.style.height = Math.max(2, Math.round(p[1] / max * 136)) + 'px'
    b.title = p[0] + '：' + p[1]
    if(i === d.series.length - 1) b.className = 'today'
    bars.appendChild(b)
  })
  put('#axA', d.series.length ? d.series[0][0].slice(5) : '')
  put('#axB', '今天')

  var sum = d.byAsset.setup + d.byAsset.portable || 1
  var a = Math.round(d.byAsset.setup / sum * 100)
  var segs = $('#mix').children
  segs[0].style.width = a + '%'
  segs[1].style.width = (100 - a) + '%'
  $('#mixRows').innerHTML =
    '<div class="row"><span class="n">安装版 Setup</span><span class="v lead">' + d.byAsset.setup + '</span></div>' +
    '<div class="row"><span class="n">免安装 Portable</span><span class="v">' + d.byAsset.portable + '</span></div>'

  if(d.github){
    put('#kStars', d.github.stars)
    put('#kStarsSub', 'Fork ' + d.github.forks)
    put('#rel', 'v' + d.github.tag + ' · GitHub 上累计 ' + d.github.downloads + ' 次（含重复）')
  } else {
    put('#rel', '拿不到 GitHub 数据（多半是接口限流）')
  }
})

$('#out').onclick = function(){
  fetch('/api/logout', {method:'POST'}).then(function(){location.href='/admin'})
}

var dlg = $('#dlg')
$('#pwd').onclick = function(){ $('#perr').style.display='none'; dlg.showModal() }
$('#cancel').onclick = function(){ dlg.close() }
$('#pf').addEventListener('submit', async function(e){
  e.preventDefault()
  var err = $('#perr')
  var res = await fetch('/api/password', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      oldPassword: $('#old').value,
      username: $('#nu').value,
      newPassword: $('#np').value
    })
  })
  if(res.ok){ dlg.close(); location.reload(); return }
  var d = {}
  try { d = await res.json() } catch(_) {}
  err.textContent = d.error || '保存失败'
  err.style.display = 'block'
});
"""


def login_page(error=''):
    err = '<div class="err">%s</div>' % html.escape(error) if error else ''
    return (
        '<!doctype html><html lang="zh-CN"><head>'
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>登录 · Nota 后台</title><style>' + CSS + LOGIN_CSS + '</style></head><body>'
        '<header class="top"><div class="wrap">' + MARK +
        '<span class="brand">Nota 后台</span></div></header>'
        '<div class="center"><div class="box">'
        '<h1>登录</h1>'
        '<p class="say">只有管理员账号能进。这里没有注册，也没有找回密码。</p>'
        + err +
        '<form id="f" method="post" action="/api/login">'
        '<label for="u">账号</label>'
        '<div class="field"><input id="u" name="username" autocomplete="username" value="admin" required></div>'
        '<label for="p">密码</label>'
        '<div class="field"><input id="p" name="password" type="password" '
        'autocomplete="current-password" required autofocus></div>'
        '<button class="btn" type="submit">登录</button>'
        '</form>'
        '<p class="foot">连错 5 次锁 15 分钟。登录态存在 HttpOnly Cookie 里，七天有效。</p>'
        '</div></div><script>' + LOGIN_JS + '</script></body></html>'
    )


def admin_page(username):
    u = html.escape(username)
    return (
        '<!doctype html><html lang="zh-CN"><head>'
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>后台 · Nota</title><style>' + CSS + ADMIN_CSS + '</style></head><body>'
        '<header class="top"><div class="wrap">' + MARK + '<span class="brand">Nota 后台</span>'
        '<span class="spacer"></span>'
        '<span class="muted" style="margin-right:8px">' + u + '</span>'
        '<button class="ghost" id="pwd">改密码</button>'
        '<button class="ghost" id="out">退出</button>'
        '</div></header>'
        '<main><div class="wrap"><h1>数据概览</h1><div class="kpis">'
        '<div class="card kpi"><div class="k">累计下载</div><div class="v" id="kTotal">–</div>'
        '<div class="s" id="kTotalSub">&nbsp;</div></div>'
        '<div class="card kpi"><div class="k">今日</div><div class="v" id="kToday">–</div>'
        '<div class="s">按去重后的下载算</div></div>'
        '<div class="card kpi"><div class="k">近 7 天</div><div class="v" id="k7">–</div>'
        '<div class="s" id="k7Sub">&nbsp;</div></div>'
        '<div class="card kpi"><div class="k">GitHub 星标</div><div class="v" id="kStars">–</div>'
        '<div class="s" id="kStarsSub">&nbsp;</div></div>'
        '</div><div class="grid">'
        '<div class="card pad"><h2>近 30 天</h2><div class="bars" id="bars"></div>'
        '<div class="axis"><span id="axA"></span><span id="axB"></span></div>'
        '<div class="tip">这里的数只有本站下载才记得到。之前发在 GitHub Releases 上的那些不计入'
        ' —— 那边的 download_count 也不准，夹着爬虫和镜像。</div></div>'
        '<div class="card pad"><h2>按安装包</h2>'
        '<div class="bar" id="mix"><span style="width:0;background:#2f6f52"></span>'
        '<span style="width:0;background:#a8c6b6"></span></div>'
        '<div id="mixRows"></div><h2 style="margin-top:18px">最新版本</h2>'
        '<div id="rel" class="muted">读取中…</div></div>'
        '</div></div></main>'
        '<dialog id="dlg"><form method="dialog" class="pad" id="pf">'
        '<h2>改账号密码</h2><label>当前密码</label>'
        '<div class="field"><input type="password" id="old" autocomplete="current-password" required></div>'
        '<label>新账号</label>'
        '<div class="field"><input id="nu" value="' + u + '" autocomplete="username" required></div>'
        '<label>新密码（至少 10 位）</label>'
        '<div class="field"><input type="password" id="np" autocomplete="new-password" minlength="10" required></div>'
        '<div class="err" id="perr" style="display:none"></div>'
        '<button class="btn" type="submit">保存</button>'
        '<button class="ghost" type="button" id="cancel" style="width:100%;margin-top:8px;height:34px">取消</button>'
        '</form></dialog>'
        '<script>' + ADMIN_JS + '</script></body></html>'
    )


# ── 主体 ──────────────────────────────────────────────────

class Admin(object):
    def __init__(self, db_path, secret_path, root):
        self.db_path = db_path
        self.secret_path = secret_path
        self.root = root
        self._gh = None          # GitHub 结果缓存 (ts, data)
        self._ensure()

    # 数据库 ──────────────────────────────

    def conn(self):
        c = sqlite3.connect(self.db_path, timeout=8)
        c.row_factory = sqlite3.Row
        return c

    def _ensure(self):
        d = os.path.dirname(self.db_path)
        if d and not os.path.isdir(d):
            os.makedirs(d)
        s = os.path.dirname(self.secret_path)
        if s and not os.path.isdir(s):
            os.makedirs(s)
        if not os.path.isfile(self.secret_path):
            with open(self.secret_path, 'w') as f:
                f.write(os.urandom(32).hex())
            os.chmod(self.secret_path, 0o600)

        c = self.conn()
        try:
            c.execute('PRAGMA journal_mode=WAL')
            c.executescript("""
                CREATE TABLE IF NOT EXISTS admin(
                  id INTEGER PRIMARY KEY,
                  username TEXT NOT NULL,
                  pwd_salt TEXT NOT NULL,
                  pwd_hash TEXT NOT NULL,
                  pwd_ver INTEGER NOT NULL DEFAULT 1,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS downloads(
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  asset TEXT NOT NULL,
                  day TEXT NOT NULL,
                  ts INTEGER NOT NULL,
                  ip_hash TEXT
                );
                CREATE INDEX IF NOT EXISTS ix_dl_day ON downloads(day);
                CREATE TABLE IF NOT EXISTS login_attempts(
                  ip_hash TEXT PRIMARY KEY,
                  fails INTEGER NOT NULL,
                  lock_until INTEGER NOT NULL,
                  last_ts INTEGER NOT NULL
                );
            """)
            row = c.execute('SELECT COUNT(*) AS n FROM admin').fetchone()
            if not row or row['n'] == 0:
                salt = new_salt()
                c.execute(
                    'INSERT INTO admin(id,username,pwd_salt,pwd_hash,pwd_ver,updated_at)'
                    ' VALUES(1,?,?,?,1,?)',
                    (DEFAULT_USER, salt, pbkdf2(DEFAULT_PASS, salt), int(time.time())),
                )
                print('[admin] 已初始化默认账号 %s / %s —— 登录后请立刻改掉'
                      % (DEFAULT_USER, DEFAULT_PASS), flush=True)
            c.commit()
        finally:
            c.close()

    # 会话 ────────────────────────────────

    def secret(self):
        with open(self.secret_path) as f:
            return f.read().strip().encode()

    def sign(self, payload):
        body = b64(json.dumps(payload, separators=(',', ':')).encode())
        sig = hmac.new(self.secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
        return body + '.' + sig

    def verify(self, token):
        if not token or '.' not in token:
            return None
        body, sig = token.rsplit('.', 1)
        want = hmac.new(self.secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, want):
            return None
        try:
            payload = json.loads(unb64(body).decode())
        except Exception:
            return None
        if int(payload.get('exp', 0)) < time.time() * 1000:
            return None
        return payload

    def pwd_ver(self):
        c = self.conn()
        try:
            row = c.execute('SELECT pwd_ver FROM admin WHERE id=1').fetchone()
            return row['pwd_ver'] if row else 0
        finally:
            c.close()

    def session(self, handler):
        raw = handler.headers.get('Cookie') or ''
        token = ''
        for part in raw.split(';'):
            part = part.strip()
            if part.startswith(COOKIE + '='):
                token = part[len(COOKIE) + 1:]
        s = self.verify(token)
        if not s:
            return None
        # token 里的版本号必须跟库里一致：改过密码，旧 token 立刻作废
        if s.get('v') != self.pwd_ver():
            return None
        return s

    def ip_hash(self, handler):
        ip = handler.client_address[0] if handler.client_address else '0.0.0.0'
        return hmac.new(self.secret(), ip.encode(), hashlib.sha256).hexdigest()[:16]

    # 统计 ────────────────────────────────

    def record_download(self, asset):
        try:
            c = self.conn()
            try:
                now = time.time()
                c.execute(
                    'INSERT INTO downloads(asset,day,ts,ip_hash) VALUES(?,?,?,NULL)',
                    (asset, day_key(now), int(now)),
                )
                c.commit()
            finally:
                c.close()
        except Exception as e:  # 统计失败不能把下载搞挂
            print('[admin] 记下载失败：%s' % e, flush=True)

    def stats(self):
        c = self.conn()
        try:
            by_asset = {'setup': 0, 'portable': 0}
            for r in c.execute('SELECT asset, COUNT(*) AS n FROM downloads GROUP BY asset'):
                by_asset[r['asset']] = r['n']
            today = day_key()
            yday = day_key(time.time() - 86400)
            week = day_key(time.time() - 6 * 86400)

            def count(day):
                row = c.execute('SELECT COUNT(*) AS n FROM downloads WHERE day=?',
                                (day,)).fetchone()
                return row['n'] if row else 0

            n_today = count(today)
            n_yday = count(yday)
            row = c.execute('SELECT COUNT(*) AS n FROM downloads WHERE day>=?',
                            (week,)).fetchone()
            n_week = row['n'] if row else 0

            # 近 30 天：缺的日子要补 0，否则柱状图会把空档压掉，看着像连着的
            by_day = {}
            for r in c.execute(
                'SELECT day, COUNT(*) AS n FROM downloads WHERE day>=? GROUP BY day',
                (day_key(time.time() - 29 * 86400),),
            ):
                by_day[r['day']] = r['n']
            series = []
            for i in range(29, -1, -1):
                d = day_key(time.time() - i * 86400)
                series.append([d, by_day.get(d, 0)])
        finally:
            c.close()

        return {
            'total': by_asset.get('setup', 0) + by_asset.get('portable', 0),
            'byAsset': {
                'setup': by_asset.get('setup', 0),
                'portable': by_asset.get('portable', 0),
            },
            'today': n_today,
            'yesterday': n_yday,
            'last7': n_week,
            'series': series,
            'github': self.github_stats(),
        }

    def github_stats(self):
        if self._gh and time.time() - self._gh[0] < 600:
            return self._gh[1]
        out = None
        try:
            req = urllib.request.Request(
                'https://api.github.com/repos/' + REPO,
                headers={'User-Agent': 'nota-site', 'Accept': 'application/vnd.github+json'},
            )
            with urllib.request.urlopen(req, timeout=6) as r:
                repo = json.loads(r.read().decode('utf-8'))
            req2 = urllib.request.Request(
                'https://api.github.com/repos/' + REPO + '/releases',
                headers={'User-Agent': 'nota-site', 'Accept': 'application/vnd.github+json'},
            )
            with urllib.request.urlopen(req2, timeout=6) as r:
                rels = json.loads(r.read().decode('utf-8'))
            dl = 0
            tag = ''
            for rel in rels:
                if not tag:
                    tag = str(rel.get('tag_name', '')).lstrip('v')
                for a in rel.get('assets') or []:
                    dl += int(a.get('download_count') or 0)
            out = {
                'stars': repo.get('stargazers_count', 0),
                'forks': repo.get('forks_count', 0),
                'tag': tag,
                'downloads': dl,
            }
        except Exception:
            out = None
        self._gh = (time.time(), out)
        return out

    # 响应 ────────────────────────────────

    def send(self, handler, code, body, ctype='application/json; charset=utf-8', cookie=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        handler.send_response(code)
        handler.send_header('Content-Type', ctype)
        handler.send_header('Content-Length', str(len(body)))
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            handler.send_header('Set-Cookie', cookie)
        handler.end_headers()
        if handler.command != 'HEAD':
            handler.wfile.write(body)

    def send_json(self, handler, code, obj, cookie=None):
        self.send(handler, code, json.dumps(obj, ensure_ascii=False), cookie=cookie)

    def same_origin(self, handler):
        origin = handler.headers.get('Origin')
        if not origin:
            return True          # 某些客户端不带，交给 SameSite 兜
        host = handler.headers.get('Host') or ''
        try:
            from urllib.parse import urlparse
            return urlparse(origin).netloc == host
        except Exception:
            return False

    def read_json(self, handler):
        try:
            n = int(handler.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > 8192:
            return None
        try:
            return json.loads(handler.rfile.read(n).decode('utf-8'))
        except Exception:
            return None

    def cookie_header(self, token, handler):
        # 证书是给域名签的，这台机器对外一定是 https；本机自测才走 http，
        # 所以 Secure 只在真的 TLS 连接上加，否则 localhost 上登录不上。
        secure = ''
        try:
            if _ssl and isinstance(handler.connection, _ssl.SSLSocket) and handler.connection.cipher():
                secure = ' Secure;'
        except Exception:
            pass
        return '%s=%s; HttpOnly;%s SameSite=Lax; Path=/; Max-Age=%d' % (
            COOKIE, token, secure, SESSION_DAYS * 86400)

    # 路由 ────────────────────────────────

    def route(self, handler):
        """认领的路径返回 True（响应已写完），其余交回静态服务。"""
        path = handler.path.split('?', 1)[0]
        method = handler.command

        if path in ('/admin', '/admin/'):
            sess = self.session(handler)
            page = admin_page(sess['u']) if sess else login_page()
            self.send(handler, 200, page, 'text/html; charset=utf-8')
            return True

        if not path.startswith('/api/'):
            return False

        if path == '/api/stats':
            if method not in ('GET', 'HEAD'):
                self.send_json(handler, 405, {'error': '方法不对'})
                return True
            if not self.session(handler):
                self.send_json(handler, 401, {'error': '没登录'})
                return True
            self.send_json(handler, 200, self.stats())
            return True

        if path == '/api/login':
            self.login(handler)
            return True

        if path == '/api/logout':
            self.send_json(handler, 200, {'ok': True},
                           cookie='%s=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' % COOKIE)
            return True

        if path == '/api/password':
            self.password(handler)
            return True

        if path == '/api/info':
            self.info(handler)
            return True

        self.send_json(handler, 404, {'error': '没有这个接口'})
        return True

    def login(self, handler):
        if not self.same_origin(handler):
            self.send_json(handler, 403, {'error': '来源不对'})
            return
        body = self.read_json(handler)
        if body is None:
            self.send_json(handler, 400, {'error': '请求格式不对'})
            return
        username = str(body.get('username') or '').strip()
        password = str(body.get('password') or '')
        if not username or not password:
            self.send_json(handler, 400, {'error': '账号和密码都要填'})
            return

        ip = self.ip_hash(handler)
        now = int(time.time())
        c = self.conn()
        try:
            att = c.execute('SELECT fails, lock_until FROM login_attempts WHERE ip_hash=?',
                            (ip,)).fetchone()
            if att and att['lock_until'] > now:
                mins = int((att['lock_until'] - now + 59) // 60)
                self.send_json(handler, 429, {'error': '连错太多次，%d 分钟后再试' % mins})
                return

            row = c.execute('SELECT username,pwd_salt,pwd_hash,pwd_ver FROM admin WHERE id=1').fetchone()
            ok = False
            if row and row['username'] == username:
                ok = hmac.compare_digest(pbkdf2(password, row['pwd_salt']), row['pwd_hash'])
            if not ok:
                fails = (att['fails'] if att else 0) + 1
                lock = now + LOCK_SEC if fails >= MAX_FAILS else 0
                c.execute(
                    'INSERT OR REPLACE INTO login_attempts(ip_hash,fails,lock_until,last_ts)'
                    ' VALUES(?,?,?,?)', (ip, fails, lock, now))
                c.commit()
                self.send_json(handler, 401, {'error': '账号或密码不对'})
                return

            c.execute('DELETE FROM login_attempts WHERE ip_hash=?', (ip,))
            c.commit()
            token = self.sign({'u': row['username'], 'v': row['pwd_ver'],
                               'exp': int((time.time() + SESSION_DAYS * 86400) * 1000)})
            self.send_json(handler, 200, {'ok': True},
                           cookie=self.cookie_header(token, handler))
        finally:
            c.close()

    def password(self, handler):
        sess = self.session(handler)
        if not sess:
            self.send_json(handler, 401, {'error': '没登录'})
            return
        if not self.same_origin(handler):
            self.send_json(handler, 403, {'error': '来源不对'})
            return
        body = self.read_json(handler)
        if body is None:
            self.send_json(handler, 400, {'error': '请求格式不对'})
            return
        old = str(body.get('oldPassword') or '')
        new_user = str(body.get('username') or '').strip() or sess['u']
        new_pwd = str(body.get('newPassword') or '')
        if len(new_pwd) < 10:
            self.send_json(handler, 400, {'error': '新密码至少 10 位'})
            return

        c = self.conn()
        try:
            row = c.execute('SELECT pwd_salt,pwd_hash,pwd_ver FROM admin WHERE id=1').fetchone()
            if not hmac.compare_digest(pbkdf2(old, row['pwd_salt']), row['pwd_hash']):
                self.send_json(handler, 401, {'error': '当前密码不对'})
                return
            salt = new_salt()
            ver = int(row['pwd_ver']) + 1
            c.execute(
                'UPDATE admin SET username=?,pwd_salt=?,pwd_hash=?,pwd_ver=?,updated_at=? WHERE id=1',
                (new_user, salt, pbkdf2(new_pwd, salt), ver, int(time.time())))
            c.commit()
            token = self.sign({'u': new_user, 'v': ver,
                               'exp': int((time.time() + SESSION_DAYS * 86400) * 1000)})
            self.send_json(handler, 200, {'ok': True},
                           cookie=self.cookie_header(token, handler))
        finally:
            c.close()

    def info(self, handler):
        """公开接口：官网按钮要用。读根目录的 info.json，没有就给空壳。"""
        data = {}
        try:
            p = os.path.join(self.root, 'info.json')
            with open(p, 'rb') as f:
                data = json.loads(f.read().decode('utf-8'))
        except Exception:
            data = {'version': '', 'assets': {'setup': {}, 'portable': {}}}
        self.send_json(handler, 200, data)
