#!/usr/bin/env python3
"""
给 Nota 官网用的静态服务。

    python3 serve.py 80

为什么不用 `python3 -m http.server`：

1. 它是**单线程**的。有人点下载（80MB），整站就被这一个连接占住，别人开首页
   要等到下载结束。多线程版本 3.7 才自带（ThreadingHTTPServer），这台是 3.6。
2. 它不支持 Range。下载断了只能从头再来，也没法多线程下载。

所以这里两件事自己做：线程池 + 按 Range 切片返回。
不做的事：不缓存、不压缩、不管 HTTPS —— 前面该有 nginx 的地方才管那些。
"""
import http.server
import os
import re
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CERTDIR = '/etc/nota'
RANGE_RE = re.compile(r'bytes=(\d*)-(\d*)')

# 后台（登录 / 改密 / 下载统计）。文件不在就是没有后台，站点照常跑。
sys.path.insert(0, ROOT)
try:
    from nota_admin import Admin
except Exception as _e:          # noqa: BLE001  缺文件不该把整站拖垮
    Admin = None
    print('后台模块没加载上：%s' % _e, flush=True)

ADMIN = None
# 路径可以拿环境变量顶掉：本机自测要用临时目录，别去碰 /var/lib
DB_PATH = os.environ.get('NOTA_DB') or '/var/lib/nota/nota.db'
SECRET_PATH = os.environ.get('NOTA_SECRET') or os.path.join(CERTDIR, 'session.key')


class Handler(http.server.SimpleHTTPRequestHandler):
    # 注意：不要给父类传 directory=ROOT —— 那是 3.7 才有的参数，这台是 3.6，
    # 传了会在**每个请求**构造时抛 TypeError，表现是端口在听、连接被立刻关掉
    # （curl 报空回复），而不是服务起不来，很容易看错方向。
    # 目录靠启动时的 os.chdir(ROOT) 决定。

    def log_message(self, fmt, *args):
        # 默认写到 stderr 也是进 journald，保持同一份日志格式即可
        sys.stderr.write('%s - - %s\n' % (self.address_string(), fmt % args))

    # 后台的几条路先过 Admin，剩下的才是静态文件。
    # 放在 do_GET 最前面而不是 send_head 里 —— 后台要自己写状态码和 cookie，
    # 走到 send_head 就已经被标准实现接管了。
    def do_GET(self):
        if ADMIN is not None and ADMIN.route(self):
            return
        self._note_download()
        return http.server.SimpleHTTPRequestHandler.do_GET(self)

    def do_HEAD(self):
        if ADMIN is not None and ADMIN.route(self):
            return
        return http.server.SimpleHTTPRequestHandler.do_HEAD(self)

    def do_POST(self):
        if ADMIN is not None and ADMIN.route(self):
            return
        self.send_error(405, 'POST 只给 /api/ 用')

    def _note_download(self):
        """记一次下载。

        只算「从头开始」的请求：浏览器断点续传时带 Range: bytes=1000000-，
        那是同一次下载的第二段，再记一遍会把总数吹起来。
        爬虫和 HEAD 不算 —— HEAD 是官网按钮在探文件在不在。
        """
        path = self.path.split('?', 1)[0]
        if not path.startswith('/d/'):
            return
        name = path.rsplit('/', 1)[-1].lower()
        if 'portable' in name:
            asset = 'portable'
        elif 'setup' in name:
            asset = 'setup'
        else:
            return
        rng = self.headers.get('Range')
        if rng:
            m = RANGE_RE.match(rng.strip())
            if m and m.group(1) and int(m.group(1)) > 0:
                return
        ADMIN.record_download(asset)

    def end_headers(self):
        # 下载别让浏览器猜；站点自己的文件里没有需要缓存很久的
        if self.path.startswith('/d/'):
            self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def send_head(self):
        """只在带 Range 且目标是静态文件时接管，其余交给标准实现。"""
        rng = self.headers.get('Range')
        if not rng:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path) or not os.path.isfile(path):
            return super().send_head()

        m = RANGE_RE.match(rng.strip())
        if not m:
            return super().send_head()

        size = os.path.getsize(path)
        start_s, end_s = m.group(1), m.group(2)
        if start_s:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        elif end_s:  # 只给了结尾：最后 N 字节
            start = max(0, size - int(end_s))
            end = size - 1
        else:
            return super().send_head()

        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_error(416, 'Requested Range Not Satisfiable')
            return None

        f = open(path, 'rb')
        f.seek(start)

        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()

        # 只把这一段交回给 copyfile，靠剩余长度控制，不整体读进内存
        remaining = end - start + 1
        orig = f.read

        def read_limited(n=-1):
            nonlocal remaining
            if remaining <= 0:
                return b''
            if n is None or n < 0 or n > remaining:
                n = remaining
            data = orig(n)
            remaining -= len(data)
            return data

        f.read = read_limited  # type: ignore[assignment]
        return f


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class RedirectToHttps(Handler):
    """80 端口：除了 ACME 验证路径，一律 301 到 https。
    挑战路径必须留在 http —— Let's Encrypt 只从 80 取。"""

    def do_GET(self):
        if self.path.startswith('/.well-known/'):
            return Handler.do_GET(self)
        host = (self.headers.get('Host', '') or '').split(':')[0]
        self.send_response(301)
        self.send_header('Location', 'https://%s%s' % (host, self.path))
        self.send_header('Content-Length', '0')
        self.end_headers()

    do_HEAD = do_GET


def main():
    global ADMIN
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    tls_port = int(sys.argv[2]) if len(sys.argv) > 2 else 443
    os.chdir(ROOT)

    if Admin is not None:
        try:
            ADMIN = Admin(DB_PATH, SECRET_PATH, ROOT)
            print('后台已就绪：/admin    数据库 %s' % DB_PATH, flush=True)
        except Exception as e:      # noqa: BLE001
            # 数据库建不出来（比如 /var/lib 不可写）就降到站点目录旁边，
            # 后台照开 —— 总比整个 /admin 404 强
            fallback = os.path.join(os.path.dirname(ROOT), 'nota-data')
            print('数据库 %s 不可用（%s），改用 %s' % (DB_PATH, e, fallback), flush=True)
            try:
                ADMIN = Admin(os.path.join(fallback, 'nota.db'),
                              os.path.join('/tmp', 'nota-session.key'), ROOT)
                print('后台已就绪（降级路径）：/admin', flush=True)
            except Exception as e2:  # noqa: BLE001
                print('后台起不来，/admin 将是 404：%s' % e2, flush=True)

    cert = os.path.join(CERTDIR, 'fullchain.pem')
    key = os.path.join(CERTDIR, 'key.pem')
    has_tls = os.path.isfile(cert) and os.path.isfile(key)

    srv80 = Server(('0.0.0.0', port), RedirectToHttps if has_tls else Handler)
    print('serving %s on :%d%s' % (ROOT, port, '  (TLS 已启用，80 只做跳转)' if has_tls else ''), flush=True)

    if not has_tls:
        srv80.serve_forever()
        return

    import ssl
    import threading

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    srv443 = Server(('0.0.0.0', tls_port), Handler)
    srv443.socket = ctx.wrap_socket(srv443.socket, server_side=True)
    print('serving %s on :%d  (TLS)' % (ROOT, tls_port), flush=True)

    th = threading.Thread(target=srv443.serve_forever)
    th.daemon = True
    th.start()
    srv80.serve_forever()


if __name__ == '__main__':
    main()
