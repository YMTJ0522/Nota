-- Nota 后台的库结构。
--   wrangler d1 execute nota --remote --file=schema.sql

/* 管理员只有一行。CHECK (id = 1) 是从表结构上堵死「再插一个管理员」这条路 ——
   应用层的 if 会被绕过，约束不会。 */
CREATE TABLE IF NOT EXISTS admin (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  username   TEXT    NOT NULL,
  pwd_salt   TEXT    NOT NULL,
  pwd_hash   TEXT    NOT NULL,
  -- 改一次密码就加一。会话 token 里带着这个号，对不上就作废，
  -- 于是「改了密码，别处登着的还活着」这件事不会发生。
  pwd_ver    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

/* 下载记录。
   一个 IP 同一天同一个包只算一次（唯一索引 + INSERT OR IGNORE）：
   download_count 那种数字里夹着爬虫、镜像和重复点击，没意义。
   这里宁可少算，也算的是「真的有人来下过」。 */
CREATE TABLE IF NOT EXISTS downloads (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  asset     TEXT    NOT NULL,
  day       TEXT    NOT NULL,
  ip_hash   TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  referer   TEXT,
  country   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dl_once ON downloads (asset, day, ip_hash);
CREATE INDEX IF NOT EXISTS idx_dl_day ON downloads (day);

/* 登录失败计数。5 次锁 15 分钟，锁的粒度是 IP。
   不记 IP 原文，只存哈希 —— 这台机器不需要知道你从哪来，只需要知道别再来试。 */
CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash   TEXT PRIMARY KEY,
  fails     INTEGER NOT NULL DEFAULT 0,
  lock_until INTEGER NOT NULL DEFAULT 0,
  last_ts   INTEGER NOT NULL
);
