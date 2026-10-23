#!/usr/bin/env python
"""
把站点推上服务器并装好。

    NOTA_PASS=xxx python deploy/remote-deploy.py --probe      # 只看环境
    NOTA_PASS=xxx python deploy/remote-deploy.py              # 全量（连安装包一起）
    NOTA_PASS=xxx python deploy/remote-deploy.py --quick      # 只更新页面与截图

为什么不用 ssh + sshpass：Windows 上既没有 sshpass，OpenSSH 的密码也只从
控制台读，管道喂不进去（SSH_ASKPASS 在 Windows 要一个 .exe，bat/ps1 都不行）。
paramiko 走纯 SSH 协议，不依赖本机 ssh 客户端，顺便把上传也一起做了。
密码只从环境变量读，不上命令行 —— 免得留在进程列表和 shell 历史里。
"""
import argparse
import os
import sys
import time

import paramiko

HOST = os.environ.get('NOTA_HOST', '8.154.24.105')
USER = os.environ.get('NOTA_USER', 'root')
PASS = os.environ.get('NOTA_PASS', '')
DOMAIN = os.environ.get('NOTA_DOMAIN', 'ymtj.hyper99.top')
ROOT = '/var/www/nota'

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.join(HERE, 'server', 'install-local.sh')
SERVE = os.path.join(HERE, 'server', 'serve.py')
ADMINPY = os.path.join(HERE, 'server', 'nota_admin.py')
SITE = os.path.join(HERE, '..', 'site')


def newest_bundle():
    """release/ 下最新的 nota-site-*.tgz —— 省得每次手打版本号。"""
    rel = os.path.join(HERE, '..', 'release')
    try:
        hits = [os.path.join(rel, n) for n in os.listdir(rel)
                if n.startswith('nota-site-') and n.endswith('.tgz')]
    except OSError:
        return ''
    return max(hits, key=os.path.getmtime) if hits else ''


BUNDLE = os.environ.get('NOTA_BUNDLE', '') or newest_bundle()


def run(cli, cmd, timeout=600, quiet=False):
    """跑一条命令，边跑边把输出打出来。"""
    if not quiet:
        print(f'\n$ {cmd}')
    chan = cli.get_transport().open_session()
    chan.settimeout(timeout)
    chan.exec_command(cmd)
    out = []
    while True:
        if chan.recv_ready():
            data = chan.recv(65536).decode('utf-8', 'replace')
            out.append(data)
            if not quiet:
                sys.stdout.write(data)
                sys.stdout.flush()
        if chan.recv_stderr_ready():
            data = chan.recv_stderr(65536).decode('utf-8', 'replace')
            out.append(data)
            if not quiet:
                sys.stdout.write(data)
                sys.stdout.flush()
        if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
            break
        time.sleep(0.05)
    code = chan.recv_exit_status()
    chan.close()
    return code, ''.join(out)


def put(sftp, local, remote, label='', progress=False):
    """上传。文本文件顺手把 CRLF 抹掉 —— Windows 上写出来的 .sh 到 Linux 上
    会把 `set -euo pipefail` 读成非法参数（`pipefail\\r`），脚本第一步就挂。"""
    data = open(local, 'rb').read()
    if local.endswith(('.sh', '.py', '.json', '.txt')) and b'\r\n' in data:
        data = data.replace(b'\r\n', b'\n')

    t0 = time.time()
    state = {'pct': 0}

    if label:
        print(f'上传 {label}' + (f'（{len(data) / 1048576:.1f} MB）' if progress else '') + ' …')

    with sftp.file(remote, 'wb') as f:
        chunk = 256 * 1024
        total = len(data)
        sent = 0
        while sent < total:
            f.write(data[sent:sent + chunk])
            sent += chunk
            if progress:
                pct = int(min(sent, total) * 100 / total)
                if pct >= state['pct'] + 10:
                    state['pct'] = pct
                    print(f'  {pct}%  {sent / 1048576:.1f}/{total / 1048576:.1f} MB', flush=True)
    if label:
        print(f'  完成，用时 {time.time() - t0:.1f}s')


def sync_site(cli, sftp):
    """把 site/ 整目录同步上去，并删掉远端已经不再存在的旧图。"""
    base = os.path.abspath(SITE)
    local = {}
    for dirpath, _, names in os.walk(base):
        for n in names:
            lp = os.path.join(dirpath, n)
            rel = os.path.relpath(lp, base).replace(os.sep, '/')
            local[rel] = lp

    run(cli, f'mkdir -p {ROOT}/shots', quiet=True)
    for rel, lp in sorted(local.items()):
        put(sftp, lp, f'{ROOT}/{rel}')
        print(f'  {rel}')

    _, out = run(cli, f'ls -1 {ROOT}/shots 2>/dev/null || true', quiet=True)
    for name in out.split():
        if f'shots/{name}' not in local:
            run(cli, f'rm -f {ROOT}/shots/{name}', quiet=True)
            print(f'  删掉远端旧图 {name}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--probe', action='store_true', help='只看环境，不动文件')
    ap.add_argument('--quick', action='store_true', help='只更新页面与截图，不传安装包')
    ap.add_argument('--rerun', action='store_true',
                    help='只推安装脚本，用服务器上已有的 /root/nota-site.tgz 重跑一遍')
    ap.add_argument('--bundle', default=BUNDLE, help='本地部署包路径')
    args = ap.parse_args()

    if not PASS:
        sys.exit('缺少密码：用 NOTA_PASS=<密码> 环境变量传')

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f'连接 {USER}@{HOST} …')
    cli.connect(HOST, port=22, username=USER, password=PASS, timeout=15,
                allow_agent=False, look_for_keys=False)
    print('连上了')

    if args.probe:
        run(cli, 'uname -a')
        run(cli, 'cat /etc/redhat-release 2>/dev/null || head -3 /etc/os-release')
        run(cli, 'python3 -V; python -V')
        run(cli, 'ss -ltnp 2>/dev/null | grep -E ":80 |:443 " || echo "80/443 没有监听"')
        run(cli, 'systemctl is-enabled nota 2>/dev/null; systemctl is-active nota 2>/dev/null')
        run(cli, f'ls -l {ROOT}/d/ {ROOT}/shots 2>/dev/null')
        run(cli, 'df -h / | tail -1; free -m | head -2')
        cli.close()
        return

    sftp = cli.open_sftp()

    if args.rerun:
        # 服务器上已经有包了，只想换安装脚本再跑一遍（改自检文案、改 unit 之类）
        print('\n== 重跑模式：只推安装脚本 ==')
        put(sftp, INSTALL, '/root/install-local.sh', '安装脚本')
        sftp.close()
        code, _ = run(cli, 'bash /root/install-local.sh /root/nota-site.tgz')
        print(f'\n安装脚本退出码：{code}')

    elif args.quick:
        print('\n== 快速模式：只更新站点 ==')
        sync_site(cli, sftp)
        put(sftp, SERVE, f'{ROOT}/serve.py')
        print('  serve.py')
        if os.path.isfile(ADMINPY):
            put(sftp, ADMINPY, f'{ROOT}/nota_admin.py')
            print('  nota_admin.py')
        sftp.close()
        run(cli, f'chmod 644 {ROOT}/nota_admin.py 2>/dev/null; chmod 755 {ROOT}/serve.py')
        run(cli, f'cd {ROOT} && python3 -m py_compile serve.py nota_admin.py && echo "serve.py / nota_admin.py 语法 OK"')
        # unit 里如果还挂着 `-m http.server`，光换文件是不生效的 —— 得改启动命令
        _, unit = run(cli, 'grep -q "serve.py" /etc/systemd/system/nota.service && echo had || echo none', quiet=True)
        if 'had' not in unit:
            print('  systemd 启动命令还是 http.server，改成 serve.py')
            run(cli, '''cat > /etc/systemd/system/nota.service <<'UNIT'
[Unit]
Description=Nota site (python static server)
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/nota
ExecStart=/usr/bin/python3 /var/www/nota/serve.py 80
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable nota >/dev/null 2>&1; true''')
        run(cli, 'systemctl restart nota; sleep 1; systemctl is-active nota')
    else:
        if not args.bundle or not os.path.isfile(args.bundle):
            sys.exit(f'找不到部署包：{args.bundle}（先跑 node scripts/make-deploy-bundle.mjs）')
        put(sftp, args.bundle, '/root/nota-site.tgz', '部署包', progress=True)
        put(sftp, INSTALL, '/root/install-local.sh', '安装脚本')
        sftp.close()
        code, _ = run(cli, 'bash /root/install-local.sh /root/nota-site.tgz')
        print(f'\n安装脚本退出码：{code}')

    # 80 装了 TLS 之后只做 301，真正要验的是 443（-k 因为证书是给域名签的，
    # 从 127.0.0.1 访会报 mismatch，这里只关心服务本身通不通）
    run(cli, 'curl -sk -o /dev/null -w "本机首页(https) %{http_code}\\n" https://127.0.0.1/')
    run(cli, 'curl -sk -o /dev/null -w "本机下载(Range 1000B) %{http_code} %{size_download}\\n" -r 0-1000 https://127.0.0.1/d/setup.exe')
    run(cli, 'curl -s -o /dev/null -w "80 跳转 %{http_code}\\n" http://127.0.0.1/')
    run(cli, 'curl -sk -o /dev/null -w "后台 /admin %{http_code}\\n" https://127.0.0.1/admin')
    run(cli, 'curl -sk https://127.0.0.1/admin | grep -o "Nota 后台" | head -1')
    _, out = run(cli, f'grep -c device-base {ROOT}/index.html || true', quiet=True)
    print(f'\n服务器上的页面含 device-base：{out.strip()} 处')
    cli.close()
    print('服务器侧完成。外网验证在本地做。')


if __name__ == '__main__':
    main()
