#!/usr/bin/env node
/* P0 Gate A 探针：macOS Seatbelt 能否作为代渲染进程的强制文件边界。
 *
 * 必须在 DSH 工具沙箱之外运行（嵌套 sandbox-exec 会 EPERM）：
 *   node scripts/probes/gate-a-macos.mjs
 * 由 Lead 用 danger-full-access 执行并归档证据。
 *
 * 结论口径：P0 只验证“能不能建立边界、边界是否覆盖后代、路径攻击是否被挡住”。
 * 最小 Remotion still/短 MP4、字体/Chromium/缓存整链与宿主退出清理留给 P5 Gate A 全量。
 *
 * 已知平台事实（2026-10-26，macOS 27.0.1）：全局 (deny file-read-data) 会让
 * sandbox-exec Abort trap 6；定向 (deny file-read-data (subpath ...)) 正常。
 * 因此读取边界采用“敏感根定向拒绝 + 白名单放行”，不是全局读白名单。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, release as osRelease, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputIndex = process.argv.indexOf('--output')
const OUT = resolve(outputIndex === -1 ? join(ROOT, 'artifacts/probes/gate-a.json') : process.argv[outputIndex + 1])
const SANDBOX = '/usr/bin/sandbox-exec'
const NODE = process.execPath
const NODE_PREFIX = resolve(dirname(NODE), '..')
const REAL_HOME = homedir()

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'teach-gate-a-')))
const job = join(tempRoot, 'job')
const outside = join(tempRoot, 'outside')
const sandboxHome = join(job, 'home')
for (const dir of [job, outside, sandboxHome, join(job, 'cache'), join(job, 'tmp')]) mkdirSync(dir, { recursive: true })

const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: sandboxHome,
  TMPDIR: join(job, 'tmp'),
  LANG: 'en_US.UTF-8'
}

const profile = [
  '(version 1)',
  '(allow default)',
  '(deny file-write*)',
  '(allow file-write* (subpath ' + JSON.stringify(job) + '))',
  '(allow file-write* (literal "/dev/null"))',
  '(allow file-write* (literal "/dev/tty"))',
  // 定向读取拒绝：临时根（工程外）、真实 HOME、共享目录、系统临时目录
  '(deny file-read-data (subpath ' + JSON.stringify(tempRoot) + '))',
  '(deny file-read-data (subpath ' + JSON.stringify(REAL_HOME) + '))',
  '(deny file-read-data (subpath "/Users/Shared"))',
  '(deny file-read-data (subpath "/private/tmp"))',
  '(deny file-read-data (subpath "/private/var/tmp"))',
  '(deny file-read-data (subpath "/var/tmp"))',
  // 白名单放行：任务目录（含 HOME/TMPDIR）、工程根、Node 运行前缀
  '(allow file-read-data (subpath ' + JSON.stringify(job) + '))',
  '(allow file-read-data (subpath ' + JSON.stringify(ROOT) + '))',
  '(allow file-read-data (subpath ' + JSON.stringify(NODE_PREFIX) + '))'
].join('\n')

const profileFile = join(tempRoot, 'profile.sb')
writeFileSync(profileFile, profile + '\n')

function run(command, sandboxed) {
  const argv = sandboxed
    ? [SANDBOX, '-f', profileFile, '/bin/sh', '-c', command]
    : ['/bin/sh', '-c', command]
  const result = spawnSync(argv[0], argv.slice(1), { cwd: job, env, timeout: 20000, encoding: 'utf8' })
  return {
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout ?? '').trim().slice(0, 300),
    stderr: (result.stderr ?? '').trim().slice(0, 300)
  }
}

const denied = (r) => r.status !== 0 && /operation not permitted|permission denied/i.test(r.stderr)

const reset = () => {
  for (const name of ['link', 'dangling', 'swap', 'hard']) rmSync(join(job, name), { force: true, recursive: true })
  for (const name of ['escaped.txt', 'dangling.txt', 'swap-x.txt', 'descendant.txt', 'tampered.txt', 'secret.txt']) rmSync(join(outside, name), { force: true })
  rmSync(join(job, 'pids.json'), { force: true })
  writeFileSync(join(outside, 'secret.txt'), 'outside-secret\n')
  writeFileSync(join(outside, 'tampered.txt'), 'original\n')
}

const cases = []
function check(id, description, prepare, command, options = {}) {
  const arm = () => { reset(); prepare?.() }
  arm()
  const control = run(command, false)
  const controlOk = options.controlOk ? options.controlOk(control) : control.status === 0
  arm()
  const sandboxed = run(command, true)
  const sandboxOk = options.sandboxOk ? options.sandboxOk(sandboxed) : true
  cases.push({ id, description, critical: options.critical !== false, command, control, sandboxed, controlOk, sandboxOk })
}

// 1. 允许：写授权目录
check('write-granted', '授权目录内写入应成功', null,
  'mkdir -p cache && echo ok > cache/result.txt && cat cache/result.txt',
  { sandboxOk: (r) => r.status === 0 && r.stdout === 'ok' })

// 2. 拒绝：写工程外目录（对照证明可写）
check('write-outside', '授权目录外写入应被拒绝', null,
  'echo escaped > ../outside/escaped.txt && cat ../outside/escaped.txt',
  { controlOk: (r) => r.status === 0 && r.stdout === 'escaped', sandboxOk: (r) => denied(r) })

// 3. 拒绝：写真实用户目录（/Users/Shared 是普通用户可写目录）
const sharedProbe = '/Users/Shared/.__teach_gate_a_probe'
check('write-users-shared', '真实用户可写目录应被拒绝', null,
  'echo x > /Users/Shared/.__teach_gate_a_probe && cat /Users/Shared/.__teach_gate_a_probe',
  {
    controlOk: (r) => {
      const ok = r.status === 0 && r.stdout === 'x'
      rmSync(sharedProbe, { force: true })
      return ok
    },
    sandboxOk: (r) => denied(r) && !existsSync(sharedProbe)
  })

// 4. 拒绝：目录 symlink 逃逸
check('symlink-dir-escape', '授权目录内的目录 symlink 指向外部时不得逃逸', () => {
  symlinkSync(outside, join(job, 'link'))
}, 'echo escaped > link/escaped.txt && cat ../outside/escaped.txt',
  { controlOk: (r) => r.status === 0 && r.stdout === 'escaped', sandboxOk: (r) => denied(r) })

// 5. 拒绝：悬空 symlink 逃逸（旧 sandbox.js 的漏洞）
check('symlink-dangling-escape', '悬空 symlink 指向外部新文件时不得创建外部文件', () => {
  symlinkSync(join(outside, 'dangling.txt'), join(job, 'dangling'))
}, 'echo escaped > dangling && cat ../outside/dangling.txt',
  { controlOk: (r) => r.status === 0 && r.stdout === 'escaped', sandboxOk: (r) => denied(r) && !existsSync(join(outside, 'dangling.txt')) })

// 6. 拒绝：校验后把目录替换为外部 symlink（TOCTOU 静态版）
check('directory-replace', '校验后把目录替换为外部 symlink 时写入仍应被拒绝', () => {
  symlinkSync(outside, join(job, 'swap'))
}, 'echo escaped > swap/swap-x.txt && cat ../outside/swap-x.txt',
  { controlOk: (r) => r.status === 0 && r.stdout === 'escaped', sandboxOk: (r) => denied(r) && !existsSync(join(outside, 'swap-x.txt')) })

// 7. 拒绝：硬链接改写外部文件
check('hardlink-write-through', '通过硬链接改写外部文件应被拒绝', null,
  'ln ../outside/tampered.txt hard && echo pwned > hard',
  {
    controlOk: (r) => r.status === 0 && readFileSync(join(outside, 'tampered.txt'), 'utf8').includes('pwned'),
    sandboxOk: (r) => !readFileSync(join(outside, 'tampered.txt'), 'utf8').includes('pwned')
  })

// 8. 拒绝：读取工程外文件（敏感读边界）
check('read-outside', '读取授权外文件应被拒绝', null,
  'cat ../outside/secret.txt',
  { controlOk: (r) => r.status === 0 && r.stdout === 'outside-secret', sandboxOk: (r) => denied(r) })

// 9. 拒绝：读取真实 HOME 下文件（若存在）
const homeFile = ['.zshrc', '.bashrc', '.profile'].map((n) => join(REAL_HOME, n)).find((p) => existsSync(p))
check('read-home', '读取真实 HOME 文件应被拒绝', null,
  homeFile ? 'head -c 1 ' + JSON.stringify(homeFile) + ' > /dev/null' : 'true',
  {
    critical: Boolean(homeFile),
    controlOk: (r) => r.status === 0,
    sandboxOk: (r) => denied(r),
    skipped: !homeFile
  })

// 10. 允许：读取项目内文件
check('read-project', '读取声明的工程文件应成功', null,
  'cat ' + JSON.stringify(join(ROOT, 'package.json')) + ' > cache/package-copy.txt && test -s cache/package-copy.txt',
  { sandboxOk: (r) => r.status === 0 })

// 11. 允许：执行系统二进制
check('exec-system', '执行系统二进制（echo）应成功', null,
  '/bin/echo exec-system-ok',
  { sandboxOk: (r) => r.status === 0 && r.stdout === 'exec-system-ok' })

// 12. 拒绝：执行授权外复制的二进制
check('exec-outside', '执行授权外程序应被拒绝', () => {
  const script = join(outside, 'echo-copy')
  writeFileSync(script, '#!/bin/sh\necho outside-exec\n')
  chmodSync(script, 0o755)
}, '../outside/echo-copy outside-exec',
  { controlOk: (r) => r.status === 0 && r.stdout === 'outside-exec', sandboxOk: (r) => r.status !== 0 })

// 13. 后代继承：node 再 fork /bin/sh 写外部，仍应被拒绝
writeFileSync(join(job, 'descendant.cjs'), [
  "const { spawnSync } = require('node:child_process')",
  "const r = spawnSync('/bin/sh', ['-c', 'echo descendant > ../outside/descendant.txt'], { encoding: 'utf8' })",
  'process.exit(r.status === 0 ? 0 : 7)'
].join('\n'))
check('descendant-inherit', '渲染器后代进程应继承同一写边界', null,
  JSON.stringify(NODE) + ' descendant.cjs',
  {
    controlOk: (r) => r.status === 0 && existsSync(join(outside, 'descendant.txt')),
    sandboxOk: (r) => r.status !== 0 && !existsSync(join(outside, 'descendant.txt'))
  })

// 14. 取消/超时：Seatbelt 不负责杀进程，执行适配器必须按进程组终止后代
async function timeoutCase() {
  reset()
  const script = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const child = spawn('/bin/sleep', ['30'])",
    "fs.writeFileSync('pids.json', JSON.stringify({ parent: process.pid, child: child.pid }))",
    'setInterval(() => {}, 1000)'
  ].join('\n')
  const child = spawn(SANDBOX, ['-f', profileFile, NODE, '-e', script], { cwd: job, env, detached: true, stdio: 'ignore' })
  const pidFile = join(job, 'pids.json')
  const deadline = Date.now() + 8000
  while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  let pids = null
  try { pids = JSON.parse(readFileSync(pidFile, 'utf8')) } catch {}
  let killed = false
  if (pids) {
    try { process.kill(-child.pid, 'SIGTERM'); killed = true } catch {}
    const exited = await new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit(false), 3000)
      child.on('exit', () => { clearTimeout(timer); resolveExit(true) })
    })
    if (!exited) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    await new Promise((r) => setTimeout(r, 300))
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  const result = {
    id: 'timeout-process-group',
    description: '取消时按进程组终止可清掉 sandbox-exec 与后代；Seatbelt 自身不杀进程',
    critical: false,
    pids,
    killed,
    sandboxExecAlive: alive(child.pid),
    descendantAlive: pids ? alive(pids.child) : null
  }
  result.passed = result.killed && !result.sandboxExecAlive && result.descendantAlive === false
  cases.push(result)
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
}

await timeoutCase()

const critical = cases.filter((c) => c.critical)
const summary = {
  probe: 'gate-a-macos',
  checkedAt: new Date().toISOString(),
  status: 'runnable',
  platform: {
    os: process.platform,
    arch: process.arch,
    osVersion: readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8').match(/<string>([^<]+)<\/string>/g)?.slice(0, 2)
  },
  identity: { uid: process.getuid?.(), node: process.version, execPath: NODE, sandboxExec: SANDBOX, realHome: REAL_HOME },
  tempRoot,
  grants: { write: [job, '/dev/null', '/dev/tty'], readDenied: [tempRoot, REAL_HOME, '/Users/Shared', '/private/tmp', '/private/var/tmp', '/var/tmp'], readAllowed: [job, ROOT, NODE_PREFIX] },
  profile,
  profileSha256: createHash('sha256').update(profile).digest('hex'),
  cases,
  passed: critical.every((c) => c.controlOk && c.sandboxOk),
  platformFinding: 'macOS 27.0.1：全局 (deny file-read-data) 触发 sandbox-exec Abort trap 6；定向 deny + 白名单 allow 正常。',
  scopeNote: 'P0 只验证 Seatbelt 边界可行性与后代继承；最小 Remotion still/短 MP4、字体/Chromium/缓存、宿主退出清理在 P5 Gate A 全量验证。'
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n')
for (const c of cases) console.log((c.controlOk === false || c.sandboxOk === false ? '✗' : '✓') + ' ' + c.id + (c.critical ? '' : ' (informational)'))
console.log('passed=' + summary.passed + ' evidence=' + OUT)
rmSync(tempRoot, { recursive: true, force: true })
process.exit(summary.passed ? 0 : 1)