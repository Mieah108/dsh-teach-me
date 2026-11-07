import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  JSX_MARK,
  MARK,
  inspectAnimation,
  integrationState,
  parseLessonEntry,
  planRootIntegration,
  registerManagedNamespace,
  renderRegistry,
  syncLesson,
  unifiedDiff
} from '../../lib/animation-managed.js'
import { ProjectError, openProject } from '../../lib/sandbox.js'

/** 最典型的 Remotion Root.tsx：带手写注释、别的视频、fragment 返回值。 */
const ROOT_TSX = [
  "import { Composition } from 'remotion'",
  "import { OldVideo } from './videos/LLM/old'",
  '',
  'export const RemotionRoot: React.FC = () => {',
  '  // 手写注释：受管接入不能吃掉这一行',
  '  return (',
  '    <>',
  '      <Composition id="OldVideo" component={OldVideo} durationInFrames={90} fps={30} width={1920} height={1080} />',
  '    </>',
  '  )',
  '}',
  ''
].join('\n')

const INDEX_TS = ["import { registerRoot } from 'remotion'", "import { RemotionRoot } from './Root'", '', 'registerRoot(RemotionRoot)', ''].join('\n')

function makeProject(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-managed-project-'))
  const root = path.join(base, 'project')
  fs.mkdirSync(root)
  const withPackage = options.packageJson !== null
  if (withPackage) {
    const pkg = options.packageJson ?? {
      name: 'demo-project',
      dependencies: { remotion: '4.0.0', '@remotion/cli': '4.0.0', react: '18.0.0' }
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2))
  }
  if (options.deps !== false) {
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'remotion'), '#!/bin/sh\nexit 0\n')
  }
  if (options.indexSource !== null) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), options.indexSource ?? INDEX_TS)
  }
  if (options.rootSource !== null) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'Root.tsx'), options.rootSource ?? ROOT_TSX)
  }
  fs.writeFileSync(path.join(root, 'src', 'theme.ts'), 'export const palette = {}\n')
  fs.mkdirSync(path.join(root, 'src', 'videos', 'shared'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'videos', 'shared', 'chrome.tsx'), 'export const Chrome = () => null\n')
  if (typeof options.extra === 'function') options.extra(root)
  return {
    root,
    base,
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true })
    }
  }
}

function makeWorkspace(slug, files) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-managed-workspace-'))
  const dir = path.join(workspace, '.dsh-teach-me', 'animation-src', slug)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  return { workspace, dir, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) }
}

function configFor(root) {
  return { animation: { enabled: true, root, softLimitSeconds: 120 }, tools: { animation: true } }
}

/** 目录快照：文件名 + 大小 + mtime + inode + 内容哈希。 */
function snapshot(root) {
  const out = []
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const stat = fs.lstatSync(full)
      out.push({
        rel: path.relative(root, full).split(path.sep).join('/'),
        size: stat.size,
        mtime: stat.mtimeMs,
        ino: stat.ino,
        sha: createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      })
    }
  }
  walk(root)
  return out
}

function codeOf(fn) {
  try {
    fn()
    return undefined
  } catch (error) {
    assert.ok(error instanceof ProjectError, '应当抛 ProjectError，实际：' + String(error))
    return error.code
  }
}

function lessonEntry(duration = 300) {
  return [
    "import { useCurrentFrame } from 'remotion'",
    'export const DURATION_IN_FRAMES = ' + duration,
    'export const FPS = 30',
    'export const Lesson = () => null',
    ''
  ].join('\n')
}

test('inspect 只读：给出 not-integrated + 接入 diff，工程零变化', () => {
  const project = makeProject()
  try {
    const before = snapshot(project.root)
    const inspection = inspectAnimation(configFor(project.root))
    const after = snapshot(project.root)
    assert.equal(inspection.state, 'not-integrated')
    assert.equal(inspection.ready, false)
    assert.match(inspection.diff, /--- a\/src\/Root\.tsx/)
    assert.match(inspection.diff, /\+.*<teach-managed:begin>/)
    assert.match(inspection.diff, /\+.*TeachManagedCompositions/)
    assert.deepEqual(inspection.writes, ['src/Root.tsx', 'src/videos/_teach-managed/registry.tsx', '.dsh-teach/managed/state.json'])
    // 结构摘要
    assert.deepEqual(inspection.project.remotionDeps, ['@remotion/cli', 'remotion'])
    assert.equal(inspection.project.entryIndex, true)
    assert.equal(inspection.project.entryRoot, true)
    assert.equal(inspection.project.theme, true)
    assert.deepEqual(inspection.project.shared, ['chrome.tsx'])
    assert.deepEqual(inspection.project.compositionIds, ['OldVideo'])
    // 零变化：没有新建 .dsh-teach / registry，所有文件的内容、mtime、inode 都没动
    assert.deepEqual(after, before)
    assert.equal(fs.existsSync(path.join(project.root, '.dsh-teach')), false)
    assert.equal(fs.existsSync(path.join(project.root, 'src', 'videos', '_teach-managed')), false)
  } finally {
    project.cleanup()
  }
})

test('inspect 分档：unconfigured / missing-root / not-a-project / deps-missing / invalid-entry', () => {
  assert.equal(inspectAnimation({ animation: { enabled: false, root: '' } }).state, 'unconfigured')

  const missing = makeProject()
  try {
    assert.equal(inspectAnimation(configFor(path.join(missing.base, 'nope'))).state, 'missing-root')
  } finally {
    missing.cleanup()
  }

  const notProject = makeProject({ packageJson: { name: 'plain', dependencies: { react: '18.0.0' } } })
  try {
    assert.equal(inspectAnimation(configFor(notProject.root)).state, 'not-a-project')
  } finally {
    notProject.cleanup()
  }

  const noDeps = makeProject({ deps: false })
  try {
    const inspection = inspectAnimation(configFor(noDeps.root))
    assert.equal(inspection.state, 'deps-missing')
    assert.match(inspection.reason, /remotion/)
  } finally {
    noDeps.cleanup()
  }

  const noEntry = makeProject({ indexSource: null })
  try {
    assert.equal(inspectAnimation(configFor(noEntry.root)).state, 'invalid-entry')
  } finally {
    noEntry.cleanup()
  }

  const noFragment = makeProject({
    rootSource: [
      "import { Composition } from 'remotion'",
      'export const RemotionRoot: React.FC = () => (',
      '  <Composition id="A" component={() => null} durationInFrames={10} fps={30} width={10} height={10} />',
      ')',
      ''
    ].join('\n')
  })
  try {
    const inspection = inspectAnimation(configFor(noFragment.root))
    assert.equal(inspection.state, 'invalid-entry')
    assert.match(inspection.reason, /fragment/)
  } finally {
    noFragment.cleanup()
  }
})

test('register 默认 dry_run：只返回 diff 与路径，一个文件都不写', () => {
  const project = makeProject()
  try {
    const before = snapshot(project.root)
    const result = registerManagedNamespace({ config: configFor(project.root) })
    assert.equal(result.written, false)
    assert.equal(result.dryRun, true)
    assert.equal(result.changed, true)
    assert.match(result.diff, /\+.*<teach-managed:begin>/)
    assert.deepEqual(result.writes, ['src/Root.tsx', 'src/videos/_teach-managed/registry.tsx', '.dsh-teach/managed/state.json'])
    assert.deepEqual(snapshot(project.root), before)
    assert.equal(fs.existsSync(path.join(project.root, '.dsh-teach')), false)
  } finally {
    project.cleanup()
  }
})

test('register confirm：只加受管块、保留手写内容与顺序、写前备份', () => {
  const project = makeProject()
  try {
    const original = fs.readFileSync(path.join(project.root, 'src', 'Root.tsx'), 'utf8')
    const result = registerManagedNamespace({ config: configFor(project.root), confirm: true })
    assert.equal(result.written, true)
    assert.equal(result.dryRun, false)
    const updated = fs.readFileSync(path.join(project.root, 'src', 'Root.tsx'), 'utf8')

    // 手写内容按原顺序全部保留（去掉受管块后应当与原文逐行一致）
    const userLines = updated
      .split('\n')
      .filter((line) => !line.includes('<teach-managed:begin>') && !line.includes('<teach-managed:end>'))
      .filter((line) => !line.includes('TeachManagedCompositions'))
      .filter((line) => !line.includes('本块由 dsh-teach-me 维护'))
    assert.deepEqual(userLines, original.split('\n'))
    assert.deepEqual(integrationState(updated), { imports: true, jsx: true, both: true, broken: false })

    // 备份：原文件逐字节一致，并有清单
    const backupRoot = path.join(project.root, path.dirname(result.backup))
    assert.equal(fs.readFileSync(path.join(project.root, result.backup), 'utf8'), original)
    const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'))
    assert.equal(manifest.sha256, createHash('sha256').update(original).digest('hex'))

    // 受管命名空间与状态
    const registry = fs.readFileSync(path.join(project.root, 'src', 'videos', '_teach-managed', 'registry.tsx'), 'utf8')
    assert.match(registry, /export const TeachManagedCompositions/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(project.root, '.dsh-teach', 'managed', 'state.json'), 'utf8')).namespace, 'src/videos/_teach-managed')
    assert.equal(inspectAnimation(configFor(project.root)).state, 'ready')
  } finally {
    project.cleanup()
  }
})

test('register 幂等：重复调用 written=false，且不再产生新备份', () => {
  const project = makeProject()
  try {
    registerManagedNamespace({ config: configFor(project.root), confirm: true })
    const rootAfterFirst = fs.readFileSync(path.join(project.root, 'src', 'Root.tsx'), 'utf8')
    const backups = () => fs.readdirSync(path.join(project.root, '.dsh-teach', 'managed')).filter((name) => name.startsWith('backup-'))
    const firstBackups = backups().length
    const before = snapshot(project.root)

    const second = registerManagedNamespace({ config: configFor(project.root), confirm: true })
    assert.equal(second.written, false)
    assert.equal(second.changed, false)
    assert.equal(second.diff, '')
    assert.deepEqual(second.writes, [])
    assert.equal(fs.readFileSync(path.join(project.root, 'src', 'Root.tsx'), 'utf8'), rootAfterFirst)
    assert.equal(backups().length, firstBackups)
    assert.deepEqual(snapshot(project.root), before)
  } finally {
    project.cleanup()
  }
})

test('register 结构无效时明确失败且不写（不是 fragment / 只有半套标记）', () => {
  const single = makeProject({
    rootSource: ["import { Composition } from 'remotion'", 'export const RemotionRoot: React.FC = () => (', '  <Composition id="A" component={() => null} durationInFrames={10} fps={30} width={10} height={10} />', ')', ''].join('\n')
  })
  try {
    const before = snapshot(single.root)
    // 结构无效的分档由 inspect 给 invalid-entry，register 给出更具体的原因码
    assert.equal(inspectAnimation(configFor(single.root)).state, 'invalid-entry')
    assert.equal(codeOf(() => registerManagedNamespace({ config: configFor(single.root), confirm: true })), 'root-not-fragment')
    assert.deepEqual(snapshot(single.root), before)
  } finally {
    single.cleanup()
  }

  const half = makeProject({
    rootSource: [MARK.begin, '// 残留', ROOT_TSX].join('\n')
  })
  try {
    assert.equal(codeOf(() => registerManagedNamespace({ config: configFor(half.root), confirm: true })), 'managed-marker-damaged')
    assert.equal(fs.existsSync(path.join(half.root, '.dsh-teach')), false)
  } finally {
    half.cleanup()
  }
})

test('planRootIntegration 是纯函数：同一输入多次调用结果一致，且不碰文件', () => {
  const first = planRootIntegration(ROOT_TSX, INDEX_TS)
  assert.equal(first.ok, true)
  assert.equal(first.unchanged, false)
  const second = planRootIntegration(ROOT_TSX, INDEX_TS)
  assert.equal(second.updated, first.updated)
  // 幂等：拿结果再算一次应当 unchanged
  const again = planRootIntegration(first.updated, INDEX_TS)
  assert.equal(again.ok, true)
  assert.equal(again.unchanged, true)
  assert.equal(again.updated, first.updated)
})

test('sync dry_run 不创建任何目录/文件（工作区与工程都干净）', () => {
  const project = makeProject()
  const source = makeWorkspace('ropim-dataflow', { 'index.tsx': lessonEntry() })
  try {
    // dry_run 前删掉 .gitignore，确认 dry_run 不会补建暂存目录的标记文件
    const ignore = path.join(source.workspace, '.dsh-teach-me', '.gitignore')
    const result = syncLesson({ config: configFor(project.root), workspace: source.workspace, category: 'LLM', slug: 'ropim-dataflow', dryRun: true })
    assert.equal(result.written, false)
    assert.equal(result.dryRun, true)
    assert.equal(result.composition, 'RopimDataflow')
    assert.deepEqual(result.files, ['src/videos/LLM/ropim-dataflow/index.tsx'])
    assert.equal(fs.existsSync(ignore), false)
    assert.equal(fs.existsSync(path.join(project.root, 'src', 'videos', 'LLM')), false)
    assert.equal(fs.existsSync(path.join(project.root, '.dsh-teach')), false)
    assert.equal(fs.existsSync(path.join(project.root, 'src', 'videos', '_teach-managed')), false)
  } finally {
    project.cleanup()
    source.cleanup()
  }

  // 源码目录不存在时也不许建目录
  const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-managed-empty-'))
  const second = makeProject()
  try {
    assert.equal(
      codeOf(() => syncLesson({ config: configFor(second.root), workspace: emptyWorkspace, category: 'LLM', slug: 'nope', dryRun: true })),
      'staging-missing'
    )
    assert.deepEqual(fs.readdirSync(emptyWorkspace), [])
  } finally {
    second.cleanup()
    fs.rmSync(emptyWorkspace, { recursive: true, force: true })
  }
})

test('sync 整批校验：显式 files 缺失/类型不对/超限都一个文件不写', () => {
  const project = makeProject()
  try {
    const missing = makeWorkspace('lesson-a', { 'index.tsx': lessonEntry() })
    try {
      assert.equal(
        codeOf(() => syncLesson({ config: configFor(project.root), workspace: missing.workspace, category: 'LLM', slug: 'lesson-a', files: ['nope.tsx'] })),
        'file-not-staged'
      )
    } finally {
      missing.cleanup()
    }

    const badType = makeWorkspace('lesson-b', { 'index.tsx': lessonEntry(), 'notes.txt': 'x' })
    try {
      assert.equal(
        codeOf(() => syncLesson({ config: configFor(project.root), workspace: badType.workspace, category: 'LLM', slug: 'lesson-b', files: ['notes.txt'] })),
        'bad-file-type'
      )
    } finally {
      badType.cleanup()
    }

    // 两个文件，第二个超限：第一个也不许落地
    const tooLarge = makeWorkspace('lesson-c', {
      'index.tsx': lessonEntry(),
      'data.json': 'x'.repeat(512 * 1024 + 1)
    })
    try {
      assert.equal(
        codeOf(() => syncLesson({ config: configFor(project.root), workspace: tooLarge.workspace, category: 'LLM', slug: 'lesson-c' })),
        'too-large'
      )
      assert.equal(fs.existsSync(path.join(project.root, 'src', 'videos', 'LLM', 'lesson-c')), false)
      assert.equal(fs.existsSync(path.join(project.root, 'src', 'videos')), true) // 只 pre-exist 的 shared
      assert.deepEqual(fs.readdirSync(path.join(project.root, 'src', 'videos')), ['shared'])
    } finally {
      tooLarge.cleanup()
    }
  } finally {
    project.cleanup()
  }
})

test('sync 原子发布：不残留临时目录，旧受管文件清掉、用户文件保留', () => {
  const project = makeProject()
  const source = makeWorkspace('ropim-dataflow', { 'index.tsx': lessonEntry(), 'storyboard.md': '# 分镜\n' })
  try {
    const config = configFor(project.root)
    const first = syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'ropim-dataflow', revision: 'r1' })
    assert.equal(first.written, true)
    const lessonDir = path.join(project.root, 'src', 'videos', 'LLM', 'ropim-dataflow')
    assert.deepEqual(fs.readdirSync(lessonDir).sort(), ['index.tsx', 'storyboard.md'])
    // 用户自己往受管目录放了一个文件：同步不能删它
    fs.writeFileSync(path.join(lessonDir, 'my-notes.md'), '用户手写\n')

    const second = syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'ropim-dataflow', revision: 'r2', files: ['index.tsx'] })
    assert.equal(second.written, true)
    assert.deepEqual(fs.readdirSync(lessonDir).sort(), ['index.tsx', 'my-notes.md'])
    assert.equal(fs.readFileSync(path.join(lessonDir, 'my-notes.md'), 'utf8'), '用户手写\n')
    // 临时目录不留残留：同级的 .dsh-teach-tmp-* 与 .dsh-teach-old-* 都没有
    const siblings = fs.readdirSync(path.join(project.root, 'src', 'videos', 'LLM'))
    assert.deepEqual(siblings, ['ropim-dataflow'])
  } finally {
    project.cleanup()
    source.cleanup()
  }
})

test('sync 不覆盖没有清单的同名手写文件；adopt:true 才接管', () => {
  const project = makeProject()
  const source = makeWorkspace('handmade', { 'index.tsx': lessonEntry() })
  try {
    const lessonDir = path.join(project.root, 'src', 'videos', 'LLM', 'handmade')
    fs.mkdirSync(lessonDir, { recursive: true })
    fs.writeFileSync(path.join(lessonDir, 'index.tsx'), '// 用户手写的同名文件\n')
    const config = configFor(project.root)
    assert.equal(codeOf(() => syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'handmade' })), 'would-overwrite-user-file')
    assert.equal(fs.readFileSync(path.join(lessonDir, 'index.tsx'), 'utf8'), '// 用户手写的同名文件\n')

    const adopted = syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'handmade', adopt: true })
    assert.equal(adopted.written, true)
    assert.match(fs.readFileSync(path.join(lessonDir, 'index.tsx'), 'utf8'), /DURATION_IN_FRAMES/)
  } finally {
    project.cleanup()
    source.cleanup()
  }
})

test('sync 拒绝链接越界：目标父目录指向工程外时不动外面', () => {
  const project = makeProject()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-managed-outside-'))
  const source = makeWorkspace('escaping', { 'index.tsx': lessonEntry() })
  try {
    fs.symlinkSync(outside, path.join(project.root, 'src', 'videos', 'LLM'))
    assert.equal(
      codeOf(() => syncLesson({ config: configFor(project.root), workspace: source.workspace, category: 'LLM', slug: 'escaping' })),
      'symlink-escape'
    )
    assert.deepEqual(fs.readdirSync(outside), [])
  } finally {
    project.cleanup()
    source.cleanup()
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('sync 同名修订不互相覆盖：同 revision 不同内容 / 旧 revision 都拒绝', () => {
  const project = makeProject()
  const source = makeWorkspace('rev-lesson', { 'index.tsx': lessonEntry(300) })
  try {
    const config = configFor(project.root)
    syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'rev-lesson', revision: '7' })
    fs.writeFileSync(path.join(source.dir, 'index.tsx'), lessonEntry(301))
    assert.equal(codeOf(() => syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'rev-lesson', revision: '7' })), 'revision-conflict')
    assert.equal(codeOf(() => syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'rev-lesson', revision: '6' })), 'stale-revision')
    // 新 revision 可以发布
    const next = syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'rev-lesson', revision: '8' })
    assert.equal(next.written, true)
    assert.match(fs.readFileSync(path.join(project.root, 'src', 'videos', 'LLM', 'rev-lesson', 'index.tsx'), 'utf8'), /DURATION_IN_FRAMES = 301/)
  } finally {
    project.cleanup()
    source.cleanup()
  }
})

test('sync 在已接入工程里自动注册 Composition（registry 重建、清单落盘）', () => {
  const project = makeProject()
  const source = makeWorkspace('ropim-dataflow', { 'index.tsx': lessonEntry(300), 'storyboard.md': '# 分镜\n' })
  try {
    const config = configFor(project.root)
    // 未接入时：文件照常同步，Composition id 只是预告，受管 registry 与 Root.tsx 都不动
    const beforeRegister = fs.readFileSync(path.join(project.root, 'src', 'Root.tsx'), 'utf8')
    const lonely = syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'ropim-dataflow', revision: 'r1' })
    assert.equal(lonely.registered, false)
    assert.equal(lonely.composition, 'RopimDataflow')
    assert.equal(lonely.registryWritten, false)
    assert.match(lonely.hint, /teach_animation_register/)
    assert.equal(fs.existsSync(path.join(project.root, 'src', 'videos', '_teach-managed')), false)
    assert.equal(fs.readFileSync(path.join(project.root, 'src', 'Root.tsx'), 'utf8'), beforeRegister)

    // 接入后 registry 立刻按已有清单生成
    registerManagedNamespace({ config, confirm: true })
    const registryAfterRegister = fs.readFileSync(path.join(project.root, 'src', 'videos', '_teach-managed', 'registry.tsx'), 'utf8')
    assert.match(registryAfterRegister, /id="RopimDataflow"/)

    fs.writeFileSync(path.join(source.dir, 'index.tsx'), lessonEntry(420))
    const synced = syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'ropim-dataflow', revision: 'r2' })
    assert.equal(synced.registered, true)
    assert.equal(synced.composition, 'RopimDataflow')
    assert.equal(synced.registryWritten, true)
    const registry = fs.readFileSync(path.join(project.root, 'src', 'videos', '_teach-managed', 'registry.tsx'), 'utf8')
    assert.match(registry, /import \{ Lesson as Lesson0 \} from '\.\.\/LLM\/ropim-dataflow\/index'/)
    assert.match(registry, /id="RopimDataflow"/)
    assert.match(registry, /durationInFrames=\{420\}/)

    const manifest = JSON.parse(fs.readFileSync(path.join(project.root, '.dsh-teach', 'managed', 'lessons', 'LLM', 'ropim-dataflow.json'), 'utf8'))
    assert.equal(manifest.composition, 'RopimDataflow')
    assert.equal(manifest.revision, 'r2')
    assert.equal(manifest.entry.registrable, true)
    assert.equal(manifest.files.length, 2)

    const inspection = inspectAnimation(config)
    assert.equal(inspection.state, 'ready')
    assert.deepEqual(inspection.managed.lessons, [
      { category: 'LLM', slug: 'ropim-dataflow', revision: 'r2', composition: 'RopimDataflow', registrable: true }
    ])
  } finally {
    project.cleanup()
    source.cleanup()
  }
})

test('sync 入口约定不满足时不注册，但文件照常同步并说明原因', () => {
  const project = makeProject()
  const source = makeWorkspace('no-meta', { 'index.tsx': 'export const Lesson = () => null\n' })
  try {
    const config = configFor(project.root)
    registerManagedNamespace({ config, confirm: true })
    const result = syncLesson({ config, workspace: source.workspace, category: 'LLM', slug: 'no-meta' })
    assert.equal(result.written, true)
    assert.equal(result.composition, null)
    assert.match(result.hint, /DURATION_IN_FRAMES/)
    const registry = fs.readFileSync(path.join(project.root, 'src', 'videos', '_teach-managed', 'registry.tsx'), 'utf8')
    assert.match(registry, /TeachManagedCompositions = \(\) => null/)
  } finally {
    project.cleanup()
    source.cleanup()
  }
})

test('sync 目标目录里有子目录/特殊文件时拒绝整体替换', () => {
  const project = makeProject()
  const source = makeWorkspace('dirty', { 'index.tsx': lessonEntry() })
  try {
    const lessonDir = path.join(project.root, 'src', 'videos', 'LLM', 'dirty')
    fs.mkdirSync(path.join(lessonDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(lessonDir, 'assets', 'logo.png'), 'png')
    assert.equal(
      codeOf(() => syncLesson({ config: configFor(project.root), workspace: source.workspace, category: 'LLM', slug: 'dirty' })),
      'unexpected-entry'
    )
    assert.deepEqual(fs.readdirSync(lessonDir), ['assets'])
    assert.deepEqual(fs.readdirSync(path.join(lessonDir, 'assets')), ['logo.png'])
  } finally {
    project.cleanup()
    source.cleanup()
  }
})

test('parseLessonEntry / renderRegistry / unifiedDiff 是纯函数', () => {
  assert.equal(parseLessonEntry('export const Lesson = () => null\n').registrable, false)
  assert.equal(parseLessonEntry('export const DURATION_IN_FRAMES = 30\n').registrable, false)
  assert.deepEqual(parseLessonEntry(lessonEntry(90)), {
    registrable: true,
    file: 'index.tsx',
    export: 'named',
    component: 'Lesson',
    durationInFrames: 90,
    fps: 30,
    width: 1920,
    height: 1080
  })
  assert.equal(parseLessonEntry('export default () => null\nexport const DURATION_IN_FRAMES = 12\n').export, 'default')

  const empty = renderRegistry([])
  assert.match(empty, /TeachManagedCompositions = \(\) => null/)
  assert.match(empty, /import \{ Composition \} from 'remotion'/)

  const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'x.ts')
  assert.match(diff, /--- a\/x\.ts/)
  assert.match(diff, /-b/)
  assert.match(diff, /\+B/)
  assert.equal(unifiedDiff('same\n', 'same\n'), '')
})

test('目录级原子发布原语只接受自己建的临时目录', () => {
  const project = makeProject()
  try {
    fs.mkdirSync(path.join(project.root, 'src', 'videos', 'LLM'), { recursive: true })
    fs.mkdirSync(path.join(project.root, 'src', 'videos', 'LLM', '.dsh-teach-tmp-a'))
    fs.writeFileSync(path.join(project.root, 'src', 'videos', 'LLM', '.dsh-teach-tmp-a', 'index.tsx'), 'x')
    const guard = openProject(project.root)
    // 不是 .dsh-teach-tmp- 开头：拒绝
    fs.mkdirSync(path.join(project.root, 'src', 'videos', 'LLM', 'plain-dir'))
    assert.throws(() => guard.swapDir('src/videos/LLM/plain-dir', 'src/videos/LLM/target', []), /teach-tmp/)
    // 不同级：拒绝（rename 不再原子）
    fs.mkdirSync(path.join(project.root, 'src', 'videos', '.dsh-teach-tmp-root'))
    assert.throws(() => guard.swapDir('src/videos/.dsh-teach-tmp-root', 'src/videos/LLM/target', []), /同级/)
    // 正常换：临时目录变成目标目录
    const published = guard.swapDir('src/videos/LLM/.dsh-teach-tmp-a', 'src/videos/LLM/lesson', ['index.tsx'])
    assert.deepEqual(published, ['src/videos/LLM/lesson/index.tsx'])
    assert.equal(fs.existsSync(path.join(project.root, 'src', 'videos', 'LLM', '.dsh-teach-tmp-a')), false)
    // removeTempDir 只清理临时目录
    assert.throws(() => guard.removeTempDir('src/videos/LLM/lesson'), /teach-tmp/)
    assert.deepEqual(guard.listDir('src/videos/LLM/lesson').map((entry) => entry.name), ['index.tsx'])
    assert.equal(guard.listDir('src/videos/nope'), undefined)
  } finally {
    project.cleanup()
  }
})

test('受管标记常量与 JSX 标记不会互相误判', () => {
  assert.equal(MARK.begin.includes('{'), false)
  assert.equal(JSX_MARK.begin.includes('{'), true)
  assert.deepEqual(integrationState('no markers here'), { imports: false, jsx: false, both: false, broken: false })
  assert.deepEqual(integrationState([MARK.begin, MARK.end].join('\n')), { imports: true, jsx: false, both: false, broken: true })
})
