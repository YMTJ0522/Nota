/**
 * 安装界面 —— 由 Nota 自己画，不走 NSIS 的向导。
 *
 * 为什么不用现成的安装器：NSIS 那套对话框是 Win32 原生控件，按钮、单选、
 * 进度条都是系统画的，改不了样式。而 Nota 本身就是自绘窗口（frame:false），
 * 安装时突然弹出一个 2005 年的灰底向导，跟软件不是一个东西。
 *
 * 现在的做法：**免安装版（portable）就是安装包**。
 * 双击它 → 解压到临时目录 → 启动本程序 → 主进程发现自己是「从 portable 起来的」，
 * 于是先开这扇小窗：装到这台电脑？装的话把文件从临时目录拷到
 * %LOCALAPPDATA%\Programs\Nota，建快捷方式、登记卸载项，然后从新位置重启。
 * 不装就点「就用免安装的」，直接进正常界面 —— 一个文件两种用法。
 *
 * 几个必须记住的点：
 *
 * 1. 判断「我是不是 portable」只能看 PORTABLE_EXECUTABLE_FILE —— 那是
 *    electron-builder 的解压壳自己设的环境变量，正常安装后运行时不会有。
 * 2. 要拷的是 **dirname(process.execPath)**（解压出来的那份），
 *    不是 PORTABLE_EXECUTABLE_DIR（用户把 exe 放在哪），拷错了会拷成空目录。
 * 3. 拷完必须从新位置启动再退出；否则进程一退，临时目录被壳删掉，
 *    用户看到的是「装完打不开」。
 * 4. 卸载要把自己删掉：先登记一个延迟删除（cmd + ping 等两秒），
 *    再 quit。别的办法都删不掉正在运行的 exe。
 * 5. 笔记与设置一概不动 —— deleteAppDataOnUninstall 这个选项没有了，
 *    现在是我们在卸载时明确只删程序目录。
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { writeVaultPointer } from './vault'

const APP = 'Nota'
/** 卸载信息写在 HKCU 下 —— 只装给当前用户，不需要管理员权限 */
const UNINSTALL_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.ymtj.nota'

let ui: BrowserWindow | null = null
let targetDir = ''
/** 笔记目录。空表示没动过，用「文档\Nota」——安装时用户选过就是他自己那个目录 */
let notesDir = ''
let mode: 'install' | 'uninstall' = 'install'

function localAppData(): string {
  return (
    process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
  )
}

function defaultDir(): string {
  return path.join(localAppData(), 'Programs', APP)
}

/**
 * 笔记目录的默认值：「文档\Nota」。
 *
 * 不选 AppData —— 笔记藏进 AppData，用户既找不到也没法备份，重装系统跟着一起没。
 * 这个值和 vault.ts 里 ensureVault 拼出来的完全一致，改一处必须改另一处。
 */
function defaultNotesDir(): string {
  return path.join(app.getPath('documents'), APP)
}

/** 解压出来的程序目录（portable 运行时就是临时目录里的那份） */
function sourceDir(): string {
  return path.dirname(process.execPath)
}

function isInside(child: string, parent: string): boolean {
  const a = path.resolve(child).toLowerCase()
  const b = path.resolve(parent).toLowerCase()
  return a === b || a.startsWith(b + path.sep)
}

/** 装失败了留个尾巴：界面上只能显示一句话，完整堆栈写进 %LOCALAPPDATA%\Nota\install.log */
function logError(where: string, e: unknown) {
  try {
    const dir = path.join(localAppData(), APP)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'install.log'),
      `[${new Date().toISOString()}] ${where} | ${process.execPath} | ${
        (e as Error)?.stack || String(e)
      }\n`,
    )
  } catch {
    /* 日志写不进去也不能把安装本身带崩 */
  }
}

async function listFiles(root: string): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = []
  async function walk(dir: string, prefix: string) {
    const items = await fsp.readdir(dir, { withFileTypes: true })
    for (const it of items) {
      const abs = path.join(dir, it.name)
      const rel = prefix ? prefix + '/' + it.name : it.name
      if (it.isDirectory()) await walk(abs, rel)
      else if (it.isFile()) {
        const st = await fsp.stat(abs)
        out.push({ rel, size: st.size })
      }
    }
  }
  await walk(root, '')
  return out
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    // 系统策略有可能直接不让起这个进程（抛而不是发 error 事件），
    // 那样会把整个安装带崩，所以连 spawn 本身也包起来
    try {
      const p = spawn(cmd, args, { windowsHide: true })
      p.on('exit', (code) => resolve(code ?? 0))
      p.on('error', () => resolve(-1))
    } catch {
      resolve(-1)
    }
  })
}

/** 单引号包起来，内部的单引号翻倍 —— PowerShell 里唯一安全的写法 */
function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'"
}

async function makeShortcuts(exe: string, workdir: string) {
  const body = [
    '$ws = New-Object -ComObject WScript.Shell',
    '$places = @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))',
    'foreach ($p in $places) {',
    '  if (-not $p) { continue }',
    `  $lnk = Join-Path $p "Nota.lnk"`,
    '  $s = $ws.CreateShortcut($lnk)',
    `  $s.TargetPath = ${psQuote(exe)}`,
    `  $s.WorkingDirectory = ${psQuote(workdir)}`,
    `  $s.IconLocation = ${psQuote(exe + ',0')}`,
    '  $s.Description = "Nota"',
    '  $s.Save()',
    '}',
  ].join('\n')
  await run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    body,
  ])
}

async function removeShortcuts() {
  const body = [
    '$places = @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))',
    'foreach ($p in $places) {',
    '  if (-not $p) { continue }',
    '  Get-ChildItem $p -Filter "Nota.lnk" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('\n')
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', body])
}

/* 注册表不调 reg.exe，统一走 PowerShell。
   两个好处：跟建快捷方式用的是同一套调用（少一个外部依赖），
   以及某些机器上 reg.exe 被策略拦掉时不会把安装带崩。 */
async function register(exe: string, dir: string, version: string, sizeKb: number) {
  const body = [
    `$k = ${psQuote(UNINSTALL_KEY)}`,
    'New-Item -Path $k -Force | Out-Null',
    'function SetV($n, $v, $t) { New-ItemProperty -Path $k -Name $n -Value $v -PropertyType $t -Force | Out-Null }',
    `SetV 'DisplayName' 'Nota' 'String'`,
    `SetV 'DisplayVersion' ${psQuote(version)} 'String'`,
    `SetV 'Publisher' 'YMTJ0522' 'String'`,
    `SetV 'DisplayIcon' ${psQuote(exe + ',0')} 'String'`,
    `SetV 'InstallLocation' ${psQuote(dir)} 'String'`,
    `SetV 'UninstallString' ${psQuote(`"${exe}" --uninstall`)} 'String'`,
    `SetV 'EstimatedSize' ${sizeKb} 'DWord'`,
    `SetV 'NoModify' 1 'DWord'`,
    `SetV 'NoRepair' 1 'DWord'`,
  ].join('\n')
  await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body])
}

async function unregister() {
  const body = [
    `$k = ${psQuote(UNINSTALL_KEY)}`,
    'if (Test-Path $k) { Remove-Item $k -Recurse -Force }',
  ].join('\n')
  await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body])
}

/* ── 界面 ── */

function createUi() {
  ui = new BrowserWindow({
    width: 780,
    // 多了「笔记存放位置」一整块，480 会把它挤到按钮底下去。
    // 580 是留了余量的：错误提示多占两行也不会把底部按钮挤出窗口。
    height: 580,
    show: false,
    frame: false,
    // 不做 transparent：透明窗口在关掉「透明效果」的机器上会露出一圈黑边，
    // 圆角交给系统（Win11 无边框窗口自带），底色直接给主题的 --n-bg
    backgroundColor: '#16161a',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // 安装窗不需要出现在任务栏之外的地方，但要能被点到
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'installer-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  ui.once('ready-to-show', () => ui?.show())
  ui.loadFile(path.join(process.resourcesPath ?? '', 'install', 'installer.html'))
  ui.webContents.on('render-process-gone', (_e, d) => logError('render-gone', new Error(JSON.stringify(d))))
  ui.on('closed', () => {
    ui = null
  })
}

function send(channel: string, payload?: unknown) {
  if (ui && !ui.isDestroyed()) ui.webContents.send(channel, payload)
}

async function doInstall() {
  const src = sourceDir()
  const dst = targetDir || defaultDir()

  if (isInside(dst, src) || isInside(src, dst)) {
    throw new Error('安装位置不能和临时目录重叠')
  }

  /* 笔记不许放进程序目录：卸载时删的是整个程序目录，连笔记一起没了。
     这不是假想 —— 选目录的对话框会停在上一次的位置，手快点进安装目录很自然。
     反过来（程序装进笔记目录）同样不行：笔记库会被当成程序文件删。 */
  if (notesDir && (isInside(notesDir, dst) || isInside(dst, notesDir))) {
    throw new Error('笔记目录不能和程序安装目录放在一起 —— 卸载时会连笔记一起删掉，换个位置。')
  }

  send('installer:phase', { label: '正在准备', percent: 0 })
  await fsp.mkdir(dst, { recursive: true })

  /* 关键：Electron 把 fs 改造成了「认识 .asar」的版本，任何路径里带 .asar
     都会被当成压缩包根目录去解析 —— 于是拷 resources\app.asar 时它会去找
     「app.asar 里面」的文件，直接 ENOENT。安装要的就是原样的字节，
     所以这段时间把 asar 支持关掉（进程随后就退出了，不用恢复）。
     这就是之前进度卡在 94% 的真凶：app.asar 正好在列表靠后。 */
  const prevNoAsar = process.noAsar
  process.noAsar = true

  try {
    const files = await listFiles(src)
    const total = files.reduce((n, f) => n + f.size, 0) || 1
    let done = 0
    let lastSent = 0

    for (const f of files) {
      const from = path.join(src, f.rel.replace(/\//g, path.sep))
      const to = path.join(dst, f.rel.replace(/\//g, path.sep))
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true })
        await fsp.copyFile(from, to)
      } catch (e) {
        // 报错必须带文件名 —— 只说 EPERM 的话谁也猜不出是哪个文件
        throw new Error(`写入 ${f.rel} 失败：${(e as Error).message}`)
      }
      done += f.size
      const pct = Math.round((done / total) * 100)
      if (pct >= lastSent + 3 || pct === 100) {
        lastSent = pct
        send('installer:phase', { label: '正在写入文件', percent: pct })
      }
    }

    const exe = path.join(dst, path.basename(process.execPath))
    if (!fs.existsSync(exe)) throw new Error('拷贝完成后找不到主程序')

    send('installer:phase', { label: '正在创建快捷方式', percent: 100 })
    await makeShortcuts(exe, dst)

    send('installer:phase', { label: '正在登记卸载信息', percent: 100 })
    await register(exe, dst, app.getVersion(), Math.round(total / 1024))

    /* 记下笔记放哪。**只写这一个指针文件，绝不动笔记本身** ——
       目录和欢迎文档等第一次启动时由 vault.ts 建：
       「要不要写欢迎文档」取决于那一刻目录是不是空的，那是主程序的判断
       （vault.ts 里那三条规则，单独测过 34 项）。
       这里写完，第一次启动就不会再落到默认的「文档\Nota」上。 */
    send('installer:phase', { label: '正在准备笔记目录', percent: 100 })
    const preferred = notesDir || defaultNotesDir()
    let recorded = defaultNotesDir()
    try {
      await writeVaultPointer(localAppData(), preferred)
      recorded = preferred
    } catch (e) {
      // 记不住位置不算安装失败：主程序退回默认目录，功能不受影响。
      // 但完成页要如实说「会用哪个」，不能显示一个其实没生效的路径。
      logError('vault-pointer', e)
    }

    // 完成页要摆「装到哪、占多大、笔记在哪儿」，所以把这几项一起带回去
    return { exe, dir: dst, bytes: total, notes: recorded }
  } finally {
    process.noAsar = prevNoAsar
  }
}

async function doUninstall() {
  const dir = path.dirname(process.execPath)
  send('installer:phase', { label: '正在移除快捷方式', percent: 10 })
  await removeShortcuts()
  send('installer:phase', { label: '正在清除卸载信息', percent: 55 })
  await unregister()
  send('installer:phase', { label: '正在删除程序文件', percent: 80 })

  // 自己删自己：进程活着的时候 exe 被锁着，目录删不掉，得等它退出。
  // 直接 spawn 一个 PowerShell 是不行的 —— 它是本进程的后代，
  // 本进程一退，宿主（portable 的壳 / 启动它的终端）会把整棵进程树收掉，
  // 清理脚本连第一行都没跑完就没了，目录原封不动留在那儿。
  // 所以改成：写一个 .cmd，再让资源管理器去跑它 —— 资源管理器是独立进程，
  // 它起的子进程跟这棵树没关系，本进程退出不影响。
  await scheduleWipe(dir)
}

/**
 * 写一个自删脚本，交给资源管理器执行。
 * 脚本内容用 PowerShell 写盘（-Encoding Default），因为路径里可能带中文，
 * 从 Node 直接写会是 UTF-8 —— cmd 按系统代码页读，中文路径会变问号。
 */
async function scheduleWipe(dir: string) {
  const bat = path.join(os.tmpdir(), `nota-cleanup-${process.pid}.cmd`)
  const lines = [
    '@echo off',
    `set "D=${dir}"`,
    'for /l %%i in (1,1,40) do (',
    '  if not exist "%D%\\Nota.exe" goto wipe',
    '  del /f /q "%D%\\Nota.exe" >nul 2>&1',
    '  ping -n 2 127.0.0.1 >nul',
    ')',
    ':wipe',
    'rmdir /s /q "%D%" >nul 2>&1',
    'del /f /q "%~f0" >nul 2>&1',
  ]
  const here = ["@'", ...lines, "'@"].join('\r\n')
  const ps = [
    `${here} | Set-Content -LiteralPath ${psQuote(bat)} -Encoding Default`,
  ].join('\n')
  const code = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
  if (code !== 0 || !fs.existsSync(bat)) {
    logError('wipe-script', new Error('写清理脚本失败 code=' + code + ' ' + bat))
    return
  }
  try {
    // explorer 接到 .cmd 会直接执行它；这一步把脚本挪出了本进程的进程树
    spawn('explorer.exe', [bat], { detached: true, stdio: 'ignore' }).unref()
  } catch (e) {
    logError('wipe-spawn', e)
  }
}

/**
 * 主进程启动时调一次。
 * 返回 true 表示「安装/卸载界面接管了」，不要再建主窗口。
 */
export async function maybeRunInstaller(): Promise<boolean> {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  const args = process.argv.slice(1)
  const wantUninstall = args.includes('--uninstall')
  const installed = isInside(process.execPath, defaultDir())

  if (!wantUninstall && (!portable || installed)) return false

  mode = wantUninstall ? 'uninstall' : 'install'
  targetDir = defaultDir()

  ipcMain.handle('installer:info', () => ({
    mode,
    version: app.getVersion(),
    dir: targetDir,
    installDirDefault: defaultDir(),
    // 笔记目录默认值随 info 一起送到界面上，用户不改就是它
    notes: notesDir || defaultNotesDir(),
  }))

  ipcMain.handle('installer:chooseDir', async () => {
    if (!ui) return null
    const r = await dialog.showOpenDialog(ui, {
      title: '选择安装位置',
      defaultPath: targetDir,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '装到这里',
    })
    if (r.canceled || !r.filePaths[0]) return null
    // 选到 C:\Program Files 这种写不进去的地方，不拦 —— 拷贝会失败，
    // 界面会把错误原文摊出来，比这里瞎猜更有用
    targetDir = path.join(r.filePaths[0], APP)
    return targetDir
  })

  /* 选笔记放哪。跟上面那个不一样：这里选的就是目录**本身**，
     不再往后拼一层 \Nota —— 用户指着「D:\我的笔记」说就放这儿，
     再给他套一层子目录是自作主张。 */
  ipcMain.handle('installer:chooseNotes', async () => {
    if (!ui) return null
    const r = await dialog.showOpenDialog(ui, {
      title: '选择笔记存放位置',
      defaultPath: notesDir || defaultNotesDir(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '用这个文件夹',
    })
    if (r.canceled || !r.filePaths[0]) return null
    notesDir = r.filePaths[0]
    return notesDir
  })

  ipcMain.handle('installer:start', async () => {
    try {
      if (mode === 'uninstall') {
        await doUninstall()
        return { ok: true }
      }
      const r = await doInstall()
      return { ok: true, ...r }
    } catch (e) {
      logError(mode, e)
      return { ok: false, error: (e as Error).message || '安装失败' }
    }
  })

  ipcMain.handle('installer:launch', async (_e, exe?: string) => {
    const target = exe || path.join(targetDir, path.basename(process.execPath))
    if (!fs.existsSync(target)) {
      app.quit()
      return false
    }
    /* 交给资源管理器拉起，不自己 spawn。
       两个原因：一是 openPath / spawn 出来的进程都挂在这棵进程树下面，
       portable 的壳（或启动它的宿主）在安装窗退出时会收掉整棵树，
       「点打开 Nota 什么也没发生」就是这么来的；
       二是 ShellExecute 不继承 PORTABLE_EXECUTABLE_FILE，
       不会让新进程又弹一次安装窗。 */
    try {
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref()
    } catch (e) {
      logError('launch-explorer', e)
    }
    // 让新窗口先立起来，再关自己
    setTimeout(() => app.quit(), 900)
    return true
  })

  ipcMain.handle('installer:openHome', () => {
    shell.openExternal('https://ymtj.hyper99.top')
    return true
  })

  ipcMain.handle('installer:minimize', () => {
    ui?.minimize()
    return true
  })

  ipcMain.handle('installer:quit', () => {
    app.quit()
    return true
  })

  createUi()

  // 卸载是一次性的事，界面收尾自己 quit，主进程不用再建窗口
  if (mode === 'uninstall') return true

  /* 安装模式下要等用户选：装，还是「就用免安装的」。
     返回 false 才继续建主窗口 —— 这一步不能提前 resolve，
     否则主窗口会跟安装窗一起弹出来。 */
  return await new Promise<boolean>((resolve) => {
    let decided = false
    ipcMain.handle('installer:usePortable', () => {
      decided = true
      resolve(false)
      ui?.destroy()
      return true
    })
    ui?.on('closed', () => {
      // 直接关窗 = 不装了，退出；别让它掉进「正常启动」，
      // 那会先闪一下主窗口再因为 window-all-closed 退出。
      if (!decided) {
        decided = true
        resolve(true)
        app.quit()
      }
    })
  })
}
