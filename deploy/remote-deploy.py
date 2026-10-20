#!/usr/bin/env python
"""
把部署包推到服务器并装上。

    NOTA_PASS=xxx python deploy/remote-deploy.py --probe
    NOTA_PASS=xxx python deploy/remote-deploy.py

为什么不用 ssh + sshpass：Windows 上既没有 sshpass，OpenSSH 的密码也只从
控制台读，管道喂不进去（SSH_ASKPASS 在 Windows 要一个 .exe，bat/ps1 都不行）。
paramiko 走的是纯 SSH 协议，不依赖本机 ssh 客户端，顺便还能把上传一起做了。

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

BUNDLE = os.environ.get('NOTA_BUNDLE', '')
INSTALL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server', 'install-local.sh')


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--probe', action='store_true', help='只看环境，不动文件')
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

    # ── 环境 ──
    run(cli, 'uname -a')
    run(cli, 'cat /etc/redhat-release 2>/dev/null || cat /etc/os-release 2>/dev/null | head -3')
    run(cli, '(python3 -V 2>&1; python -V 2>&1) | head -4')
    run(cli, 'command -v systemctl firewalld getenforce curl ss || true')
    run(cli, 'ss -ltnp 2>/dev/null | grep -E ":80 |:443 " || echo "80/443 没有监听"')
    run(cli, 'df -h / | tail -1; free -m | head -2')

    if args.probe:
        cli.close()
        return

    if not args.bundle or not os.path.isfile(args.bundle):
        sys.exit(f'找不到部署包：{args.bundle}（先跑 node scripts/make-deploy-bundle.mjs）')

    sftp = cli.open_sftp()
    size = os.path.getsize(args.bundle)

    def put(local, remote, label):
        print(f'上传 {label}（{size / 1048576:.1f} MB）…' if label == '部署包' else f'上传 {label}…')
        t0 = time.time()
        last = [0]

        def cb(done, total):
            pct = int(done * 100 / total)
            if pct >= last[0] + 10:
                last[0] = pct
                print(f'  {pct}%  {done / 1048576:.1f}/{total / 1048576:.1f} MB', flush=True)

        sftp.put(local, remote, callback=cb)
        print(f'  完成，用时 {time.time() - t0:.1f}s')

    put(args.bundle, '/root/nota-site.tgz', '部署包')
    put(INSTALL, '/root/install-local.sh', '安装脚本')
    sftp.close()

    code, _ = run(cli, 'bash /root/install-local.sh /root/nota-site.tgz')
    print(f'\n安装脚本退出码：{code}')

    # ── 从服务器本机验一遍 ──
    run(cli, f'curl -s -o /dev/null -w "本机首页 %{{http_code}}\\n" http://127.0.0.1/')
    run(cli, f'curl -s -o /dev/null -w "本机下载 %{{http_code}} %{{size_download}} bytes\\n" http://127.0.0.1/d/setup.exe')
    run(cli, 'systemctl is-enabled nota; systemctl is-active nota')
    cli.close()
    print('\n服务器侧完成。外网验证在本地做。')


if __name__ == '__main__':
    main()
