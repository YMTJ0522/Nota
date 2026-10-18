/**
 * 后台两个页面的 HTML。
 *
 * 不引框架、不打包：这两个页面加起来就几百行，为它配一条前端构建链，
 * 收益抵不上每次改字都要等一次 build。所有交互都是原生 fetch + DOM。
 *
 * 配色跟官网同一套（纸白 / 墨色 / 深绿），后台和官网看起来像一件东西。
 */

const CSS = `
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
`;

const MARK = '<span class="mark">N</span>';

/* ── 登录 ── */

export function loginPage(error = ''): string {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · Nota 后台</title>
<style>${CSS}
body{display:flex;flex-direction:column}
.center{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
.box{width:380px;max-width:100%;padding:26px;border-radius:16px;background:var(--card);
  border:1px solid var(--line);box-shadow:0 2px 6px rgb(50 45 32/.06),0 36px 80px -30px rgb(50 45 32/.25)}
.box h1{font-size:20px;margin-bottom:6px}
.say{margin:0 0 20px;font-size:12px;color:var(--ink3);line-height:1.7}
.err{background:#fdf0ec;color:#a3402a;border-radius:9px;padding:8px 10px;font-size:12px;
  margin-bottom:14px}
.foot{margin:16px 0 0;font-size:11px;color:#b8b3a6;line-height:1.7}
</style></head><body>
<header class="top"><div class="wrap">${MARK}<span class="brand">Nota 后台</span></div></header>
<div class="center"><div class="box">
  <h1>登录</h1>
  <p class="say">只有管理员账号能进。这里没有注册，也没有找回密码。</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  <form id="f" method="post" action="/api/login">
    <label for="u">账号</label>
    <div class="field"><input id="u" name="username" autocomplete="username" value="admin" required></div>
    <label for="p">密码</label>
    <div class="field"><input id="p" name="password" type="password" autocomplete="current-password" required autofocus></div>
    <button class="btn" type="submit">登录</button>
  </form>
  <p class="foot">连错 5 次锁 15 分钟。登录态存在 HttpOnly Cookie 里，七天有效。</p>
</div></div>
<script>
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
</script></body></html>`;
}

/* ── 后台 ── */

export function adminPage(username: string): string {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>后台 · Nota</title>
<style>${CSS}
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
</style></head><body>
<header class="top"><div class="wrap">${MARK}<span class="brand">Nota 后台</span>
  <span class="spacer"></span>
  <span class="muted" style="margin-right:8px">${username}</span>
  <button class="ghost" id="pwd">改密码</button>
  <button class="ghost" id="out">退出</button>
</div></header>
<main><div class="wrap">
  <h1>数据概览</h1>
  <div class="kpis">
    <div class="card kpi"><div class="k">累计下载</div><div class="v" id="kTotal">–</div><div class="s" id="kTotalSub">&nbsp;</div></div>
    <div class="card kpi"><div class="k">今日</div><div class="v" id="kToday">–</div><div class="s">按去重后的下载算</div></div>
    <div class="card kpi"><div class="k">近 7 天</div><div class="v" id="k7">–</div><div class="s" id="k7Sub">&nbsp;</div></div>
    <div class="card kpi"><div class="k">GitHub 星标</div><div class="v" id="kStars">–</div><div class="s" id="kStarsSub">&nbsp;</div></div>
  </div>

  <div class="grid">
    <div class="card pad">
      <h2>近 30 天</h2>
      <div class="bars" id="bars"></div>
      <div class="axis"><span id="axA"></span><span id="axB"></span></div>
      <div class="tip">这里的数只有本站下载才记得到。之前发在 GitHub Releases 上的那些不计入 —— 那边的 download_count 也不准，夹着爬虫和镜像。</div>
    </div>
    <div class="card pad">
      <h2>按安装包</h2>
      <div class="bar" id="mix"><span style="width:0;background:#2f6f52"></span><span style="width:0;background:#a8c6b6"></span></div>
      <div id="mixRows"></div>
      <h2 style="margin-top:18px">最新版本</h2>
      <div id="rel" class="muted">读取中…</div>
    </div>
  </div>
</div></main>

<dialog id="dlg"><form method="dialog" class="pad" id="pf">
  <h2>改账号密码</h2>
  <label>当前密码</label>
  <div class="field"><input type="password" id="old" autocomplete="current-password" required></div>
  <label>新账号</label>
  <div class="field"><input id="nu" value="${username}" autocomplete="username" required></div>
  <label>新密码（至少 10 位）</label>
  <div class="field"><input type="password" id="np" autocomplete="new-password" minlength="10" required></div>
  <div class="err" id="perr" style="display:none"></div>
  <button class="btn" type="submit">保存</button>
  <button class="ghost" type="button" id="cancel" style="width:100%;margin-top:8px;height:34px">取消</button>
</form></dialog>

<script>
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
})
</script></body></html>`;
}
