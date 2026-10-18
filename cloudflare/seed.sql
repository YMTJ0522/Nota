-- 初始管理员：admin / admin123
--
-- 密码不存明文，存的是 PBKDF2-SHA256（10 万次迭代）的盐和结果。
-- 下面这两个值是我在本地算好粘进来的，算法与 src/auth.ts 里完全一致
-- （都用 WebCrypto，Node 和 Workers 跑的是同一套）。
--
-- 登录之后第一件事请去后台把它改掉 —— 这个初始密码是公开写在仓库里的。
--
--   wrangler d1 execute nota --remote --file=seed.sql

INSERT OR REPLACE INTO admin (id, username, pwd_salt, pwd_hash, pwd_ver, updated_at)
VALUES (
  1,
  'admin',
  '562a65f605e64253c0c5f1b8ef424995',
  '7fd6bfd85f336df77b573ee9a244532f14f406f508e36522323b01aad6b3e8f2',
  1,
  0
);
