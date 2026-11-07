/* 受管接入与事务同步（P5，ADR-0013）。
 *
 * 三个能力：
 *  1. inspect：只读诊断工程可用性（unconfigured / missing-root / not-a-project /
 *     deps-missing / invalid-entry / not-integrated / ready），并给出一次性接入 diff；
 *  2. register：把受管命名空间接进 Root.tsx，只维护两对标记之间的内容；
 *  3. syncLesson：整批校验 → 临时目录 → 目录级原子发布，失败不留半套。
 *
 * 归属原则（ADR-0013）：插件只拥有三处 ——
 *  - Root.tsx 里 MARK 与 JSX_MARK 两对标记之间的内容；
 *  - src/videos/_teach-managed/ 命名空间（registry.tsx 由同步重建）；
 *  - 工程根的 .dsh-teach/managed/（课程清单、备份、状态）。
 * 标记之外的手写内容、共享组件、其他视频一律不碰；整体替换目录前先确认目标里没有插件没写过的文件。
 * 每课注册是「约定 + 生成」：index.tsx 导出 Lesson 与 DURATION_IN_FRAMES，sync 校验后重建 registry，
 * 模型不再需要（也不被允许）手改 Root.tsx。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ProjectError, openProject } from './sandbox.js'

/** Root.tsx 里的导入标记（TS 注释）。 */
export const MARK = { begin: '// <teach-managed:begin>', end: '// <teach-managed:end>' }
/** Root.tsx 里的 JSX 标记（JSX 注释）。 */
export const JSX_MARK = { begin: '{/* <teach-managed:begin> */}', end: '{/* <teach-managed:end> */}' }

export const ROOT_REL = 'src/Root.tsx'
export const INDEX_REL = 'src/index.ts'
export const NAMESPACE_REL = 'src/videos/_teach-managed'
export const REGISTRY_REL = `${NAMESPACE_REL}/registry.tsx`
export const MANAGED_REL = '.dsh-teach/managed'
export const STATE_REL = `${MANAGED_REL}/state.json`
export const LESSONS_REL = `${MANAGED_REL}/lessons`

/** 允许从工作区镜像进工程的扩展名与体积上限。 */
export const FILE_RULES = [
  { pattern: /\.tsx?$/, label: '源码' },
  { pattern: /\.json$/, label: '数据' },
  { pattern: /\.md$/, label: '分镜' },
  { pattern: /\.css$/, label: '样式' }
]
export const MAX_FILE_BYTES = 512 * 1024
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const COMPOSITION = /^[A-Za-z0-9_]+$/
const DEFAULT_SIZE = { fps: 30, width: 1920, height: 1080 }

function fail(message, code) {
  throw new ProjectError(message, code)
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sanitizeName(value, what) {
  if (typeof value !== 'string' || !NAME.test(value)) {
    fail(`${what} 只能用字母、数字、点、下划线、连字符：${JSON.stringify(value)}`, 'bad-name')
  }
  return value
}

function normalizeRevision(value) {
  if (value === undefined || value === null || value === '') return String(Date.now())
  const text = String(value)
  if (!REVISION.test(text)) {
    fail(`revision 只能用字母、数字、点、下划线、连字符（1–64 位）：${JSON.stringify(value)}`, 'bad-revision')
  }
  return text
}

/** 工作区里的中间目录（源码暂存区，不是受管命名空间）。 */
export function stagingRoot(workspace) {
  return path.join(workspace, '.dsh-teach-me')
}

/** 某一课的源码目录：<workspace>/.dsh-teach-me/animation-src/<slug>/ */
export function lessonSourceDir(workspace, slug) {
  return path.join(stagingRoot(workspace), 'animation-src', slug)
}

/** 只在真正要写的时候建暂存目录；dry_run 不许产生任何目录。 */
function ensureStaging(workspace) {
  const base = stagingRoot(workspace)
  fs.mkdirSync(path.join(base, 'animation-src'), { recursive: true })
  const ignore = path.join(base, '.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n!.gitignore\n', 'utf8')
  return base
}

/** 只列白名单扩展名的普通文件；软链/目录一律报错（不猜它是不是源码）。 */
function listStagedFiles(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    fail(`这一课还没有写源码：${dir}`, 'staging-missing')
  }
  const files = []
  for (const entry of entries) {
    const rule = FILE_RULES.find((item) => item.pattern.test(entry.name))
    if (rule === undefined) continue
    const full = path.join(dir, entry.name)
    let stat
    try {
      stat = fs.lstatSync(full)
    } catch {
      fail(`读不了源码文件：${entry.name}`, 'staging-unreadable')
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`源码目录里的 ${entry.name} 不是普通文件（软链或特殊文件），不镜像。`, 'not-a-regular-file')
    }
    files.push({ name: entry.name, full, size: stat.size, rule: rule.label })
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return files
}

function lessonManifestRel(category, slug) {
  return `${LESSONS_REL}/${category}/${slug}.json`
}

function readJson(project, rel) {
  if (!project.exists(rel)) return undefined
  try {
    const value = JSON.parse(project.read(rel))
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/* —————————————————————————— Root.tsx 分析 —————————————————————————— */

/** 取两个标记之间的内容；缺一个标记返回 undefined（视为没接入）。 */
function span(source, begin, end) {
  const start = source.indexOf(begin)
  if (start < 0) return undefined
  const stop = source.indexOf(end, start + begin.length)
  if (stop < 0) return undefined
  return { start, stop }
}

/** 受管块现状：导入块与 JSX 块是否都在、是否只剩一半。 */
export function integrationState(source) {
  const text = String(source ?? '')
  const imports = span(text, MARK.begin, MARK.end)
  const jsx = span(text, JSX_MARK.begin, JSX_MARK.end)
  // 「只剩一半」也包括一对标记里缺了另一半 —— 这种状态插件不猜，交给人处理
  const importsHalf = text.includes(MARK.begin) !== text.includes(MARK.end)
  const jsxHalf = text.includes(JSX_MARK.begin) !== text.includes(JSX_MARK.end)
  const hasImports = imports !== undefined
  const hasJsx = jsx !== undefined
  return {
    imports: hasImports,
    jsx: hasJsx,
    both: hasImports && hasJsx,
    broken: importsHalf || jsxHalf || (hasImports !== hasJsx)
  }
}

/** src/index.ts 里 registerRoot 用的根组件名。 */
export function rootComponentName(indexSource) {
  const text = String(indexSource ?? '')
  const registered = /\bregisterRoot\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(text)
  if (registered !== null) return registered[1]
  const imported = /\bimport\s*(?:type\s*)?\{[^}]*?([A-Za-z_$][\w$]*)[^}]*\}\s*from\s*['"]\.\/Root['"]/.exec(text)
  if (imported !== null) return imported[1]
  const defaulted = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*['"]\.\/Root['"]/.exec(text)
  if (defaulted !== null) return defaulted[1]
  return 'RemotionRoot'
}

/** 最后一条顶层 import 语句结束位置（含换行）；没有 import 时返回 0。 */
export function lastImportEnd(source) {
  const lines = String(source).split('\n')
  let offset = 0
  let depth = 0
  let end = 0
  for (const line of lines) {
    const trimmed = line.trim()
    const opens = (line.match(/[{(]/g) ?? []).length
    const closes = (line.match(/[})]/g) ?? []).length
    if (depth === 0 && /^import\b/.test(trimmed)) {
      depth += opens - closes
      if (depth <= 0) {
        depth = 0
        end = offset + line.length + 1
      }
    } else if (depth > 0) {
      depth += opens - closes
      if (depth <= 0) {
        depth = 0
        end = offset + line.length + 1
      }
    }
    offset += line.length + 1
  }
  return end
}

/** 从声明位置起找根组件的 return ( ... )，返回括号内文本区间。 */
function rootReturnSpan(source, name) {
  const declaration = new RegExp('(?:export\\s+)?(?:const|function)\\s+' + name.replace(/[$]/g, '\\$') + '\\b')
  const match = declaration.exec(source)
  if (match === null) return undefined
  const bodyAt = match.index + match[0].length
  const returnAt = source.indexOf('return', bodyAt)
  const arrowAt = source.indexOf('=>', bodyAt)
  // 支持 function + return (...) 与 const X = () => (...) 两种写法
  const startAt = arrowAt >= 0 && (returnAt < 0 || arrowAt < returnAt) ? arrowAt + 2 : returnAt
  if (startAt < 0) return undefined
  const openAt = source.indexOf('(', startAt)
  if (openAt < 0) return undefined
  let depth = 0
  let quote
  for (let index = openAt; index < source.length; index += 1) {
    const char = source[index]
    if (quote !== undefined) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return { openAt, closeAt: index, inner: source.slice(openAt + 1, index) }
    }
  }
  return undefined
}

function lineIndentAt(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  const line = source.slice(lineStart, index)
  return /^[ \t]*/.exec(line)[0]
}

export function managedImportBlock() {
  return [
    MARK.begin,
    '// 本块由 dsh-teach-me 维护：块内内容会被插件覆盖，块外的手写内容与顺序不受影响。',
    "import { TeachManagedCompositions } from './videos/_teach-managed/registry'",
    MARK.end
  ].join('\n')
}

export function managedJsxBlock(indent = '') {
  return [indent + JSX_MARK.begin, indent + '<TeachManagedCompositions />', indent + JSX_MARK.end].join('\n')
}

/**
 * 计算 Root.tsx 的接入方案（纯函数，不落盘）。
 *
 * 找不到安全的插入点时明确失败，不猜：根组件必须 return 一个 fragment（<>…</>），
 * 否则插件不知道该把受管组件放在哪里，交给人工加一行。
 * @param {string} rootSource Root.tsx 原文
 * @param {string} indexSource src/index.ts 原文（用来认根组件名）
 * @returns {{ok: true, unchanged: boolean, updated: string} | {ok: false, code: string, reason: string}}
 */
export function planRootIntegration(rootSource, indexSource) {
  const source = String(rootSource ?? '')
  const current = integrationState(source)

  if (current.broken) {
    return {
      ok: false,
      code: 'managed-marker-damaged',
      reason: 'Root.tsx 里只剩一半受管标记（导入块或 JSX 块缺一个）。请手工删掉残留标记后重试，插件不猜你想保留哪一半。'
    }
  }

  if (current.both) {
    const importSpan = span(source, MARK.begin, MARK.end)
    const jsxSpan = span(source, JSX_MARK.begin, JSX_MARK.end)
    const indent = lineIndentAt(source, jsxSpan.start)
    const importBlock = managedImportBlock()
    // 行首缩进不在标记之间：比较与替换都从标记本身开始，缩进保持原样
    const jsxBlock = [JSX_MARK.begin, indent + '<TeachManagedCompositions />', indent + JSX_MARK.end].join('\n')
    const importText = source.slice(importSpan.start, importSpan.stop + MARK.end.length)
    const jsxText = source.slice(jsxSpan.start, jsxSpan.stop + JSX_MARK.end.length)
    if (importText === importBlock && jsxText === jsxBlock) {
      return { ok: true, unchanged: true, updated: source }
    }
    // 先换位置靠后的块，再换靠前的块，避免坐标漂移
    const later = jsxSpan.start > importSpan.start
      ? { span: jsxSpan, block: jsxBlock, marker: JSX_MARK }
      : { span: importSpan, block: importBlock, marker: MARK }
    const earlier = later.span === jsxSpan
      ? { span: importSpan, block: importBlock, marker: MARK }
      : { span: jsxSpan, block: jsxBlock, marker: JSX_MARK }
    let updated = source
    updated = updated.slice(0, later.span.start) + later.block + updated.slice(later.span.stop + later.marker.end.length)
    updated = updated.slice(0, earlier.span.start) + earlier.block + updated.slice(earlier.span.stop + earlier.marker.end.length)
    return { ok: true, unchanged: false, updated }
  }

  const name = rootComponentName(indexSource)
  const returned = rootReturnSpan(source, name)
  if (returned === undefined) {
    return {
      ok: false,
      code: 'root-component-missing',
      reason:
        `Root.tsx 里找不到根组件 ${name}（或它的 return 语句）。受管接入需要能定位根组件；请确认 src/index.ts 里 registerRoot(${name}) 与 Root.tsx 的导出一致。`
    }
  }
  const trimmed = returned.inner.trim()
  if (!trimmed.startsWith('<>') || !trimmed.endsWith('</>')) {
    return {
      ok: false,
      code: 'root-not-fragment',
      reason:
        `根组件 ${name} 返回的不是 fragment（<>…</>）。受管接入需要把它的 JSX 包进 <>…</> 才能安全插入受管组件；请手工包一层后重试。`
    }
  }
  const closeAt = returned.openAt + 1 + returned.inner.lastIndexOf('</>')
  const indent = lineIndentAt(source, closeAt)
  const importAt = lastImportEnd(source)

  const importText = managedImportBlock() + '\n'
  const jsxText = [JSX_MARK.begin, '<TeachManagedCompositions />', JSX_MARK.end].join('\n' + indent) + '\n' + indent
  let updated = source.slice(0, closeAt) + jsxText + source.slice(closeAt)
  updated = updated.slice(0, importAt) + importText + updated.slice(importAt)
  return { ok: true, unchanged: false, updated }
}

/** Root.tsx 里已经注册的 composition id（只读展示用）。 */
export function compositionIdsIn(source) {
  const ids = []
  const pattern = /\bid\s*=\s*(?:["']([A-Za-z0-9_-]+)["']|\{\s*["']([A-Za-z0-9_-]+)["']\s*\})/g
  let match
  while ((match = pattern.exec(String(source ?? ''))) !== null) {
    const id = match[1] ?? match[2]
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/* —————————————————————————— 每课注册约定 —————————————————————————— */

/** slug → Composition id：ropim-dataflow → RopimDataflow。 */
export function compositionIdFor(category, slug) {
  const base = String(slug)
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
  const candidate = base.length > 0 ? base : `Lesson${String(category ?? '')}`
  return COMPOSITION.test(candidate) ? candidate : `L${candidate}`
}

/**
 * 解析一课的入口约定：index.tsx 导出 Lesson 组件与 DURATION_IN_FRAMES。
 * 约定不满足时 registrable=false，sync 给出原因而不是硬注册一个坏 Composition。
 */
export function parseLessonEntry(source) {
  const text = String(source ?? '')
  const duration = /\bexport\s+const\s+DURATION_IN_FRAMES\s*=\s*(\d+)/.exec(text)
  const named = /\bexport\s+const\s+Lesson\b/.test(text)
  const defaulted = /\bexport\s+default\b/.test(text)
  if (defaulted !== true && named !== true) {
    return {
      registrable: false,
      reason: 'missing-lesson-export',
      message: 'index.tsx 里没有 export const Lesson（或 export default）。'
    }
  }
  if (duration === null) {
    return {
      registrable: false,
      reason: 'missing-duration-export',
      message: 'index.tsx 里没有 export const DURATION_IN_FRAMES = <帧数>。'
    }
  }
  const read = (pattern, fallback) => {
    const found = pattern.exec(text)
    return found === null ? fallback : Number(found[1])
  }
  return {
    registrable: true,
    file: 'index.tsx',
    export: named ? 'named' : 'default',
    component: named ? 'Lesson' : 'default',
    durationInFrames: Number(duration[1]),
    fps: read(/\bexport\s+const\s+FPS\s*=\s*(\d+)/, DEFAULT_SIZE.fps),
    width: read(/\bexport\s+const\s+WIDTH\s*=\s*(\d+)/, DEFAULT_SIZE.width),
    height: read(/\bexport\s+const\s+HEIGHT\s*=\s*(\d+)/, DEFAULT_SIZE.height)
  }
}

/** 生成受管命名空间的注册文件（纯函数，方便测试）。 */
export function renderRegistry(manifests) {
  const usable = []
  const seen = new Set()
  const sorted = [...manifests].sort(
    (a, b) =>
      String(a?.category ?? '').localeCompare(String(b?.category ?? '')) ||
      String(a?.slug ?? '').localeCompare(String(b?.slug ?? ''))
  )
  for (const manifest of sorted) {
    const entry = manifest?.entry
    if (typeof manifest?.composition !== 'string' || manifest.composition.length === 0) continue
    if (entry?.registrable !== true) continue
    let id = manifest.composition
    if (seen.has(id)) id = `${id}_${compositionIdFor('', manifest.category)}`
    seen.add(id)
    usable.push({ id, category: manifest.category, slug: manifest.slug, ...entry })
  }
  const header = [
    '/* 由 dsh-teach-me 生成，属于受管命名空间：teach_animation_sync 之后会重建。',
    ' * 手改会在下一次同步时被覆盖。自己的 Composition 请写在自己的文件里，并在 Root.tsx 里注册。',
    ' */',
    "import { Composition } from 'remotion'"
  ]
  const imports = usable.map((item, index) =>
    item.export === 'default'
      ? `import Lesson${index} from '../${item.category}/${item.slug}/index'`
      : `import { ${item.component} as Lesson${index} } from '../${item.category}/${item.slug}/index'`
  )
  if (usable.length === 0) {
    return [...header, '', 'export const TeachManagedCompositions = () => null', ''].join('\n')
  }
  const body = usable
    .map((item, index) =>
      [
        '    <Composition',
        `      id="${item.id}"`,
        `      component={Lesson${index}}`,
        `      durationInFrames={${item.durationInFrames}}`,
        `      fps={${item.fps}}`,
        `      width={${item.width}}`,
        `      height={${item.height}}`,
        '    />'
      ].join('\n')
    )
    .join('\n')
  return [...header, ...imports, '', 'export const TeachManagedCompositions = () => (', '  <>', body, '  </>', ')', ''].join('\n')
}

/** 读所有课程清单（派生数据；坏清单跳过，下次同步会重写）。 */
export function readLessonManifests(project) {
  const out = []
  for (const category of project.listDir(LESSONS_REL) ?? []) {
    if (category.kind !== 'dir') continue
    const dirRel = `${LESSONS_REL}/${category.name}`
    for (const file of project.listDir(dirRel) ?? []) {
      if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
      const manifest = readJson(project, `${dirRel}/${file.name}`)
      if (manifest !== undefined) out.push(manifest)
    }
  }
  return out.sort(
    (a, b) =>
      String(a?.category ?? '').localeCompare(String(b?.category ?? '')) ||
      String(a?.slug ?? '').localeCompare(String(b?.slug ?? ''))
  )
}

function rebuildRegistry(project) {
  const text = renderRegistry(readLessonManifests(project))
  const current = project.exists(REGISTRY_REL) ? project.read(REGISTRY_REL) : undefined
  if (current === text) return false
  project.write(REGISTRY_REL, text)
  return true
}

/* —————————————————————————— 只读诊断 —————————————————————————— */

/**
 * 只读 inspect：绝不写文件、绝不建目录。
 * @param {object} config 现取配置
 * @returns {object} readiness 分档 + 结构摘要 + 一次性接入 diff
 */
export function inspectAnimation(config) {
  const base = {
    state: 'unconfigured',
    ready: false,
    reason: '还没有配置动画工程（设置 → 插件 → 教学模式 → 动画工程）。',
    hint: '这一课先不做动画，也不要自己去找工程。',
    root: '',
    configured: config?.animation?.enabled === true,
    project: undefined,
    managed: undefined,
    diff: '',
    writes: []
  }
  if (base.configured !== true) return base

  let project
  try {
    project = openProject(config.animation.root)
  } catch (error) {
    if (error instanceof ProjectError && (error.code === 'root-missing' || error.code === 'root-not-dir')) {
      return {
        ...base,
        root: config.animation.root,
        state: 'missing-root',
        reason: error.message,
        hint: '去设置页改成一个存在的 Remotion 工程目录，或者这一课先不做动画。'
      }
    }
    throw error
  }
  base.root = project.root

  const summary = {
    packageJson: false,
    remotionDeps: [],
    hasRemotionConfig: false,
    entryIndex: false,
    entryRoot: false,
    theme: false,
    shared: [],
    videos: [],
    compositionIds: []
  }
  base.project = summary

  if (!project.exists('package.json')) {
    return {
      ...base,
      state: 'not-a-project',
      reason: `${project.root} 里没有 package.json。`,
      hint: '这不是 Remotion 工程：换一个工程根，或先按 Remotion 模板建一个。'
    }
  }
  summary.packageJson = true
  const pkg = readJson(project, 'package.json')
  if (pkg === undefined) {
    return {
      ...base,
      state: 'not-a-project',
      reason: `${project.root}/package.json 读不出来或不是合法 JSON。`,
      hint: '先修好工程清单。'
    }
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
  summary.remotionDeps = Object.keys(deps)
    .filter((name) => name === 'remotion' || name.startsWith('@remotion/'))
    .sort()
  summary.hasRemotionConfig = ['remotion.config.ts', 'remotion.config.mts', 'remotion.config.js', 'remotion.config.mjs'].some(
    (rel) => project.exists(rel)
  )
  if (summary.remotionDeps.length === 0 && summary.hasRemotionConfig !== true) {
    return {
      ...base,
      state: 'not-a-project',
      reason: `${project.root}/package.json 里没有 remotion 依赖，也没有 remotion.config.*。`,
      hint: '这不是 Remotion 工程。'
    }
  }
  if (project.exists('node_modules/.bin/remotion') !== true) {
    return {
      ...base,
      state: 'deps-missing',
      reason: `${project.root} 里没有 node_modules/.bin/remotion。`,
      hint: '先在工程目录装依赖（npm install / pnpm install），装好再回来；插件不替你装依赖。'
    }
  }

  summary.entryIndex = project.exists(INDEX_REL)
  summary.entryRoot = project.exists(ROOT_REL)
  summary.theme = project.exists('src/theme.ts') || project.exists('src/theme.tsx')
  summary.shared = (project.listDir('src/videos/shared') ?? []).map((entry) => entry.name)
  summary.videos = []
  for (const category of project.listDir('src/videos') ?? []) {
    if (category.kind !== 'dir' || category.name.startsWith('_') || category.name.startsWith('.')) continue
    if (category.name === 'shared') continue
    const lessons = (project.listDir(`src/videos/${category.name}`) ?? []).filter((entry) => entry.kind === 'dir')
    summary.videos.push({ category: category.name, lessons: lessons.map((entry) => entry.name), count: lessons.length })
  }

  if (!summary.entryIndex) {
    return {
      ...base,
      state: 'invalid-entry',
      reason: `找不到入口 ${INDEX_REL}。`,
      hint: '这个工程的入口结构不是标准 Remotion 结构（src/index.ts + src/Root.tsx）；插件不猜。'
    }
  }
  if (!summary.entryRoot) {
    return {
      ...base,
      state: 'invalid-entry',
      reason: `找不到 ${ROOT_REL}。`,
      hint: '这个工程没有 src/Root.tsx；受管接入需要一个根组件文件。'
    }
  }

  const rootSource = project.read(ROOT_REL)
  const indexSource = project.read(INDEX_REL)
  summary.compositionIds = compositionIdsIn(rootSource)
  const plan = planRootIntegration(rootSource, indexSource)
  if (!plan.ok) {
    return {
      ...base,
      state: 'invalid-entry',
      reason: plan.reason,
      hint: '把 Root.tsx 调整成可定位的结构后重试；插件不会为了接入改写你的组件。'
    }
  }

  const state = integrationState(rootSource)
  const registryExists = project.exists(REGISTRY_REL)
  const manifests = readLessonManifests(project)
  base.managed = {
    namespace: NAMESPACE_REL,
    registry: registryExists,
    blocks: { imports: state.imports, jsx: state.jsx },
    lessons: manifests.map((manifest) => ({
      category: manifest.category,
      slug: manifest.slug,
      revision: manifest.revision,
      composition: manifest.composition ?? null,
      registrable: manifest.entry?.registrable === true
    }))
  }

  if (state.both && registryExists) {
    return {
      ...base,
      state: 'ready',
      ready: true,
      reason: '工程已接入受管命名空间。',
      hint: '可以用 teach_animation_sync 发布这一课；composition id 由 sync 返回。'
    }
  }
  const wanted = []
  if (plan.unchanged !== true) wanted.push(ROOT_REL)
  if (!registryExists) wanted.push(REGISTRY_REL)
  wanted.push(STATE_REL)
  return {
    ...base,
    state: 'not-integrated',
    reason: state.both
      ? '受管块在 Root.tsx 里，但受管命名空间文件缺失；重跑 teach_animation_register 会补齐。'
      : '工程还没接入受管命名空间：需要一次性在 Root.tsx 里加一个受管块，并把接入 diff 给学习者确认。',
    hint: '先用 teach_animation_register（默认 dry_run）看 diff，确认后再 confirm: true 写入。',
    diff: plan.unchanged ? '' : rootIntegrationDiff(rootSource, plan.updated, ROOT_REL),
    writes: wanted
  }
}

/* —————————————————————————— 一次性接入 —————————————————————————— */

function backupStamp() {
  return new Date().toISOString().replace(/[^0-9TZ]/g, '')
}

/**
 * 受管命名空间注册：默认只返回 diff 与将要写入的路径，confirm: true 才落盘。
 * 写前把 Root.tsx 备份到 .dsh-teach/managed/backup-<时间>/；内容一致时 written=false。
 */
export function registerManagedNamespace({ config, confirm = false }) {
  const inspection = inspectAnimation(config)
  if (['unconfigured', 'missing-root', 'not-a-project', 'deps-missing'].includes(inspection.state)) {
    fail(inspection.reason, inspection.state)
  }
  const project = openProject(config.animation.root)
  if (!project.exists(ROOT_REL) || !project.exists(INDEX_REL)) {
    fail('工程缺少 src/Root.tsx 或 src/index.ts：受管接入需要一个标准 Remotion 入口。', 'invalid-entry')
  }
  const rootSource = project.read(ROOT_REL)
  const indexSource = project.read(INDEX_REL)
  const plan = planRootIntegration(rootSource, indexSource)
  if (!plan.ok) fail(plan.reason, plan.code)

  const registrySource = project.exists(REGISTRY_REL) ? project.read(REGISTRY_REL) : undefined
  const registryText = registrySource ?? renderRegistry(readLessonManifests(project))
  const stateExists = project.exists(STATE_REL)
  const rootChanged = plan.unchanged !== true
  const registryChanged = registrySource !== registryText
  const stamp = backupStamp()
  let backupDir = `${MANAGED_REL}/backup-${stamp}`
  if (project.exists(`${backupDir}/Root.tsx`)) {
    backupDir = `${MANAGED_REL}/backup-${stamp}-${randomBytes(3).toString('hex')}`
  }

  const writes = []
  if (rootChanged) writes.push(ROOT_REL)
  if (registryChanged) writes.push(REGISTRY_REL)
  if (!stateExists) writes.push(STATE_REL)

  const result = {
    written: false,
    dryRun: confirm !== true,
    changed: writes.length > 0,
    root: project.root,
    state: inspection.state,
    diff: rootChanged ? rootIntegrationDiff(rootSource, plan.updated, ROOT_REL) : '',
    writes,
    backup: `${backupDir}/Root.tsx`,
    namespace: { dir: NAMESPACE_REL, registry: REGISTRY_REL, registryChanged },
    hint: ''
  }

  if (writes.length === 0) {
    return { ...result, hint: '受管命名空间已接入且内容一致：没有改动任何文件（written=false）。' }
  }
  if (confirm !== true) {
    return { ...result, hint: '这是 dry_run：把 diff 给学习者看，明确同意后再用 confirm: true 调用才会写文件。' }
  }

  // 整批先校验，任何一项不合法都不写
  for (const rel of [ROOT_REL, REGISTRY_REL, STATE_REL, `${backupDir}/Root.tsx`, `${backupDir}/manifest.json`]) {
    project.checkWritable(rel)
  }

  const backupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    file: ROOT_REL,
    bytes: Buffer.byteLength(rootSource, 'utf8'),
    sha256: sha256(rootSource),
    reason: 'teach_animation_register'
  }
  project.write(`${backupDir}/Root.tsx`, rootSource)
  project.write(`${backupDir}/manifest.json`, `${JSON.stringify(backupManifest, null, 2)}\n`)
  if (registryChanged) project.write(REGISTRY_REL, registryText)
  if (rootChanged) {
    try {
      project.write(ROOT_REL, plan.updated)
    } catch (error) {
      // 备份在手，尽力把原文件写回去；Root.tsx 本身也是临时文件 + rename，不会留半个文件
      try {
        project.write(ROOT_REL, rootSource)
      } catch {
        // 原内容还在备份目录里
      }
      throw error
    }
  }
  if (!stateExists) {
    const state = {
      version: 1,
      namespace: NAMESPACE_REL,
      registry: REGISTRY_REL,
      registeredAt: new Date().toISOString(),
      blocks: { imports: MARK, jsx: JSX_MARK }
    }
    project.write(STATE_REL, `${JSON.stringify(state, null, 2)}\n`)
  }
  return {
    ...result,
    written: true,
    dryRun: false,
    hint: '受管命名空间已接入；之后每课由 teach_animation_sync 自动注册 Composition。'
  }
}

/* —————————————————————————— 事务同步 —————————————————————————— */

function batchFingerprint(entries) {
  const digest = createHash('sha256')
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    digest.update(entry.name)
    digest.update('\0')
    digest.update(entry.sha256)
    digest.update('\0')
  }
  return digest.digest('hex')
}

/**
 * 把一课的源码整批镜像进受管工程。
 *
 * 顺序：读源码 → 整批校验（类型/大小/总量/普通文件/目标路径/目录归属/修订冲突）
 * → （非 dry_run）写临时目录 → 目录级 rename 发布 → 写课程清单 → 重建受管注册。
 * 校验阶段任何一项不合法都不写一个文件；dry_run 不建任何目录与文件。
 * @returns {object} sync 结果
 */
export function syncLesson({ config, workspace, category, slug, files, dryRun = false, revision, adopt = false }) {
  const cat = sanitizeName(category, 'category')
  const lessonSlug = sanitizeName(slug, 'slug')
  if (config?.animation?.enabled !== true) {
    fail('还没有配置动画工程（设置 → 插件 → 教学模式 → 动画工程）；这一课先不做动画。', 'not-configured')
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    fail('还不知道这个会话的工作区，读不到动画源码。', 'workspace-unknown')
  }
  const stageDir = lessonSourceDir(workspace, lessonSlug)
  const staged = listStagedFiles(stageDir)
  if (staged.length === 0) fail(`源码目录里没有可同步的文件：${stageDir}`, 'nothing-to-sync')

  const wanted = Array.isArray(files) && files.length > 0 ? files.map((name) => String(name)) : undefined
  if (wanted !== undefined) {
    for (const name of wanted) {
      if (!NAME.test(name)) fail(`files 里的文件名不合法：${JSON.stringify(name)}`, 'bad-name')
      if (staged.some((file) => file.name === name)) continue
      if (fs.existsSync(path.join(stageDir, name))) {
        fail(`files 里的 ${name} 不在允许的类型里（.ts/.tsx/.json/.md/.css）。`, 'bad-file-type')
      }
      fail(`files 里列了源码目录里没有的文件：${name}`, 'file-not-staged')
    }
  }
  const selected = wanted === undefined ? staged : staged.filter((file) => wanted.includes(file.name))
  if (selected.length === 0) fail('要同步的文件列表和源码目录对不上。', 'nothing-selected')

  let total = 0
  const entries = []
  for (const file of selected) {
    if (file.size > MAX_FILE_BYTES) fail(`${file.name} 超过单文件上限 512 KB。`, 'too-large')
    total += file.size
    const text = fs.readFileSync(file.full, 'utf8')
    entries.push({ name: file.name, text, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') })
  }
  if (total > MAX_TOTAL_BYTES) {
    fail(`这一课源码合计 ${Math.round(total / 1024)} KB，超过 5 MB 上限。`, 'too-large')
  }

  const project = openProject(config.animation.root)
  const dirRel = `src/videos/${cat}/${lessonSlug}`
  const manifestRel = lessonManifestRel(cat, lessonSlug)
  const targets = entries.map((entry) => `${dirRel}/${entry.name}`)

  // 目标路径先全量校验（dry_run 也一样，但绝不落盘）
  for (const rel of targets) project.checkWritable(rel)
  project.checkWritable(manifestRel)
  const integrated = integrationState(project.exists(ROOT_REL) ? project.read(ROOT_REL) : '')
  if (integrated.both) project.checkWritable(REGISTRY_REL)

  const revisionId = normalizeRevision(revision)
  const fingerprint = batchFingerprint(entries)
  const existingManifest = readJson(project, manifestRel)
  if (existingManifest !== undefined && typeof existingManifest.revision === 'string') {
    const sameContent = existingManifest.fingerprint === fingerprint
    if (existingManifest.revision === revisionId && sameContent !== true) {
      fail(
        `修订 ${revisionId} 已经发布过不同的内容：同名修订不允许互相覆盖，换一个 revision 再同步。`,
        'revision-conflict'
      )
    }
    const before = Number(existingManifest.revision)
    const after = Number(revisionId)
    if (Number.isFinite(before) && Number.isFinite(after) && after < before && sameContent !== true) {
      fail(`修订 ${revisionId} 比已发布的 ${existingManifest.revision} 旧：拒绝用旧修订覆盖新内容。`, 'stale-revision')
    }
  }

  const existingEntries = project.listDir(dirRel)
  const owned = new Set((existingManifest?.files ?? []).map((file) => file.name))
  if (existingEntries !== undefined) {
    for (const entry of existingEntries) {
      if (entry.kind !== 'file') {
        fail(`${dirRel} 里有 ${entry.name}（${entry.kind}）：受管目录只放普通源码文件，请人工处理后重试。`, 'unexpected-entry')
      }
    }
    const incoming = new Map(entries.map((entry) => [entry.name, entry]))
    for (const entry of existingEntries) {
      if (owned.has(entry.name)) continue
      const mine = incoming.get(entry.name)
      if (mine === undefined) continue
      if (existingManifest === undefined && adopt === true) continue
      const current = project.read(`${dirRel}/${entry.name}`, MAX_FILE_BYTES)
      if (sha256(current) !== mine.sha256) {
        fail(
          `拒绝覆盖 ${dirRel}/${entry.name}：这个目录没有受管清单，而文件内容与这次源码不同。确认它归插件所有时加 adopt: true 重试；否则先把它移走。`,
          'would-overwrite-user-file'
        )
      }
    }
  }

  const parsedEntry = entries.find((entry) => entry.name === 'index.tsx')
  const entryInfo = parsedEntry === undefined ? undefined : parseLessonEntry(parsedEntry.text)
  const composition = entryInfo?.registrable === true ? compositionIdFor(cat, lessonSlug) : undefined
  const hints = []
  if (!integrated.both) {
    hints.push('工程还没做受管接入（not-integrated）：先 teach_animation_inspect 看 diff，再用 teach_animation_register 接入；接入前 sync 不改 Root.tsx。')
  }
  if (entryInfo !== undefined && entryInfo.registrable !== true) {
    hints.push(`index.tsx 没满足注册约定：${entryInfo.message} 注册只跳过这一课，其它文件照常同步。`)
  }
  if (entryInfo === undefined) hints.push('源码目录里没有 index.tsx：能同步文件，但不会生成 Composition。')
  if (integrated.both && composition !== undefined) hints.push(`Composition id 是 ${composition}：render 时用它。`)

  const base = {
    root: project.root,
    category: cat,
    slug: lessonSlug,
    revision: revisionId,
    staging: stageDir,
    files: targets,
    composition: composition ?? null,
    registered: integrated.both,
    written: false,
    dryRun: dryRun === true,
    hints
  }

  if (dryRun === true) {
    return { ...base, hint: hints[0] ?? 'dry_run：校验通过，没有任何写入。' }
  }

  ensureStaging(workspace)
  const tempRel = `src/videos/${cat}/.dsh-teach-tmp-${lessonSlug}-${randomBytes(4).toString('hex')}`
  const incomingNames = new Set(entries.map((entry) => entry.name))
  const preserved = (existingEntries ?? []).filter((entry) => !owned.has(entry.name) && !incomingNames.has(entry.name))
  // 旧目录里每一项要么是插件自己的（可被替换掉），要么已经复制进新目录；其余情况 swap 会拒绝
  const allowNames = [...new Set([...incomingNames, ...(existingEntries ?? []).map((entry) => entry.name)])]
  try {
    for (const entry of entries) project.write(`${tempRel}/${entry.name}`, entry.text)
    // 目标目录里不属于插件的文件复制进新目录，整体替换时跟着保留
    for (const entry of preserved) {
      project.write(`${tempRel}/${entry.name}`, project.read(`${dirRel}/${entry.name}`, MAX_FILE_BYTES))
    }
    project.swapDir(tempRel, dirRel, allowNames)
  } catch (error) {
    try {
      project.removeTempDir(tempRel)
    } catch {
      // 临时目录可能还没建出来
    }
    throw error
  }

  const manifest = {
    version: 1,
    category: cat,
    slug: lessonSlug,
    revision: revisionId,
    publishedAt: new Date().toISOString(),
    fingerprint,
    files: entries.map((entry) => ({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 })),
    entry: entryInfo ?? null,
    composition: composition ?? null
  }
  project.write(manifestRel, `${JSON.stringify(manifest, null, 2)}\n`)
  const registryWritten = integrated.both ? rebuildRegistry(project) : false

  return {
    ...base,
    written: true,
    dryRun: false,
    registryWritten,
    hint:
      hints[0] ??
      (composition === undefined ? '文件已同步；这一课没有生成 Composition。' : `文件已同步，Composition ${composition} 已登记。`)
  }
}

/* —————————————————————————— diff —————————————————————————— */

/** 生成 unified diff（文件只有几十行，直接 LCS 就够）。 */
export function unifiedDiff(before, after, label = ROOT_REL, context = 2) {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')
  const n = a.length
  const m = b.length
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i], aIndex: i, bIndex: j })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: '-', text: a[i], aIndex: i })
      i += 1
    } else {
      ops.push({ kind: '+', text: b[j], bIndex: j })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ kind: '-', text: a[i], aIndex: i })
    i += 1
  }
  while (j < m) {
    ops.push({ kind: '+', text: b[j], bIndex: j })
    j += 1
  }
  const changed = []
  ops.forEach((op, index) => {
    if (op.kind !== ' ') changed.push(index)
  })
  if (changed.length === 0) return ''
  const ranges = []
  for (const index of changed) {
    const from = Math.max(0, index - context)
    const to = Math.min(ops.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to)
    else ranges.push({ from, to })
  }
  const lines = [`--- a/${label}`, `+++ b/${label}`]
  for (const range of ranges) {
    const slice = ops.slice(range.from, range.to + 1)
    const oldStart = slice.find((op) => op.aIndex !== undefined)?.aIndex ?? 0
    const newStart = slice.find((op) => op.bIndex !== undefined)?.bIndex ?? 0
    const oldCount = slice.filter((op) => op.kind !== '+').length
    const newCount = slice.filter((op) => op.kind !== '-').length
    lines.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`)
    for (const op of slice) lines.push(`${op.kind}${op.text}`)
  }
  return lines.join('\n')
}

/**
 * Root.tsx 一次性接入 diff：首行固定标明「预览稿，非可应用补丁」。
 *
 * 这份 diff 展示的是结构示意（插在哪、受管块长什么样），不是能直接 git apply 的补丁：
 * 行号与上下文会随工程差异变化，真正的接入动作由 teach_animation_register 在确认后自己落盘。
 * 抬头放在最前面，任何被另存为 root-integration.diff 的副本都会自带这句说明。
 */
export const ROOT_INTEGRATION_DIFF_HEADER =
  '# 预览稿，非可应用补丁：这是 Root.tsx 的受管接入示意，行号/上下文可能与你的工程不一致，请勿直接 git apply。'

/** 带预览稿抬头的 Root.tsx 接入 diff；没有差异时仍返回空字符串（调用方据此判断未接入）。 */
export function rootIntegrationDiff(before, after, label = ROOT_REL) {
  const diff = unifiedDiff(before, after, label)
  return diff === '' ? '' : ROOT_INTEGRATION_DIFF_HEADER + '\n' + diff
}

