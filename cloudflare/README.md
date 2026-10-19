# Nota 官网 · 下载 · 后台

一个 Worker 干三件事：出官网静态页、发安装包、提供 `/admin` 后台看下载量。

为什么不分家（Pages 一套、Worker 一套）：`/admin` 和下载计数都要跟官网**同源**，
拆开就得处理跨域、两个域名、两处部署。现在是域名一个、部署一条命令，
出问题也只有一个地方要看。

```
/              官网（静态资源，边缘直出，不占 Worker 调用）
/d/setup       安装版下载（过 Worker，才记得到数）
/d/portable    免安装版下载
/admin         没登录给登录页，登录了给后台
/api/info      公开：当前版本 + 两个包的体积
/api/login  /api/logout  /api/password  /api/stats
```

## 前置

- Cloudflare 账号，域名已经接在同一个账号下（要换自定义域名的话）
- 本机装 Node，`npx wrangler login` 登录过一次

## 部署

```bash
npx wrangler login          # 只做一次，会开浏览器
node scripts/cf-deploy.mjs --dry   # 先看它要做什么
node scripts/cf-deploy.mjs         # 真的做
```

脚本按顺序做这些（漏一步的表现都很隐蔽，所以固化成脚本而不是手敲）：

| 步骤 | 命令 | 漏了会怎样 |
| --- | --- | --- |
| 建库 | `wrangler d1 create nota` | 后面所有 SQL 都报错 |
| 建表 | `wrangler d1 execute nota --remote --file=cloudflare/schema.sql` | 登录时 500 |
| 种管理员 | `... --file=cloudflare/seed.sql` | 永远登不进去 |
| 建桶 | `wrangler r2 bucket create nota-downloads` | 下载 404 |
| 会话密钥 | `wrangler secret put SESSION_SECRET` | 登录直接 500 |
| 传安装包 | `wrangler r2 object put ...` | 点了下载没反应 |
| 发版 | `wrangler deploy` | 线上还是旧代码 |

`database_id` 还是占位符时，脚本会创建数据库并把返回的 id **写回** `wrangler.toml`。

### 域名

`wrangler.toml` 里的 `[[routes]]` 已经填好 `ymtj.hyper99.top`：

```toml
[[routes]]
pattern = "ymtj.hyper99.top"
custom_domain = true
```

`custom_domain` 会顺手把 DNS 和证书配好，前提是 `hyper99.top` 这个 zone
已经接在同一个 Cloudflare 账号下。**子域不用自己先加 A / CNAME 记录**，
wrangler 会写一条指向 Worker 的解析；如果那条记录你自己提前建过，先把
它删掉，否则 `deploy` 会报记录冲突。

换域名只改这一处。没有域名就把整段删掉，用默认的
`<name>.<账号>.workers.dev` 也能访问（但下载和后台会跑在 workers.dev 上）。

## 第一次登录

`admin` / `admin123`。进去以后右上角「改密码」立刻换掉。

新密码要求 **至少 10 位** —— 默认那 8 位只是为了让你进得去，不是用来长期用的。
改完账号或密码，版本号 +1，**别处已经登着的会话会立刻失效**（见下面 `pwd_ver`）。

## 发新版

1. `npm run pack --patch`（会顺手把 `wrangler.toml` 的 `VERSION` 对齐 `package.json`）
2. `node scripts/cf-deploy.mjs`

下载文件名由 `VERSION` 拼出来（`Nota-Setup-2.7.2.exe`），R2 里的 key 固定是
`Nota-Setup.exe` / `Nota-Portable.exe`，所以传新包是覆盖，不是追加。

## 本地自检（不连线上）

```bash
node scripts/verify-cf-auth.mjs     # 口令哈希、签名、过期、篡改
node scripts/verify-cf-worker.mjs   # 真跑一遍 Worker：登录/统计/下载/改密/锁
npx tsc -p cloudflare/tsconfig.json # 类型
```

`verify-cf-worker.mjs` 用 `node:sqlite` 的内存库顶替 D1，跑的就是 `schema.sql` +
`seed.sql` 原文；R2 用 Map，静态资源直接读 `public/`。GitHub 接口故意不给 `caches`，
验的是「拉不到数据时后台照样能打开」。

## 数据是怎么算的

**一个 IP 同一天同一个包只算一次**：`downloads` 上有唯一索引
`(asset, day, ip_hash)`，插入用 `INSERT OR IGNORE`。

为什么不用 GitHub Release 的 `download_count`：那个数里夹着爬虫、镜像、重复点击，
看着涨得快，但不代表有人真在用。这里宁可少算，算的是"真的有人来下过"。

几个具体约定：

- **IP 只存哈希**：`HMAC-SHA256(SESSION_SECRET, IP)` 取前 8 字节。这台机器不需要
  知道你从哪来，只需要知道别再来试。
- **日期按东八区切**：服务器是 UTC，直接切会差 8 小时，晚上 8 点后的下载会算到"明天"。
- **只有 `Range` 从头开始（`start === 0`）才算一次**：断点续传的中间那几段不重复计。
  浏览器点下载时有时会发 `bytes=0-`，那跟直接下载是一回事，该算。

## 安全上的几个选择

- **PBKDF2-SHA256 / 10 万轮 / 16 字节盐**：Workers 里没有 bcrypt 原生实现，
  硬塞 wasm 会让项目变重；对一个管理员账号，这个强度足够。
- **会话是自己签的**：`v1.<base64url(payload)>.<hmac>`，HttpOnly + Secure +
  SameSite=Lax，7 天。没有存 token 的表——省一张表，也省"token 表被拖走"这件事。
- **`pwd_ver`**：token 里带着密码版本号，改密码时版本 +1 并与库里比对，
  于是"改了密码，别处还登着的会话"立刻作废。
- **`CHECK (id = 1)`**：管理员只有一行，从表结构上堵死"再插一个"。应用层的 if 会被绕过，
  约束不会。
- **连错 5 次锁 15 分钟**：按 IP 锁，`login_attempts` 表。锁的是这个 IP，
  别人不受牵连。
- **POST 校验 Origin**：SameSite=Lax 之外再加一道。

## 额度

- Worker 免费额度每天 10 万次请求，只有 `/d`、`/api`、`/admin` 会走 Worker，
  官网首页和图片是边缘直出，不计入。
- D1 免费额度 500 万行读/天 —— 这个后台一天读几十行。
- R2 存储 10 GB、出口流量免费（这是选 R2 而不是别的对象存储的主要原因：
  两个 80MB 的包，被下多少次都不产生流量费）。

## 和 `site/` 的关系

仓库根目录的 `site/` 是给 GitHub Pages 用的那一份，下载按钮指向 GitHub Release，
**没有计数**。`cloudflare/public/` 是 Cloudflare 这一份，按钮走 `/d/*`。

两份 HTML 会长得像，但下载那一段**本来就不一样**（一个要计数，一个不用），
不用强行同步。只打算用 Cloudflare 的话，`site/` 可以不更新。
