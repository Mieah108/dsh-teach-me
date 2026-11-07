/* 内容版本与资源快照。页面仍保留原相对路径；快照根由课堂服务选择。 */
import fs from 'node:fs'
import path from 'node:path'
import { assertInside, atomicWrite, ensureRealDir, hashJson, sha256 } from './util.js'
import { ValidationError } from './errors.js'

export function contentFingerprint(html, questions, materials, assets = []) {
  // 外观与脚本资产修订不等于内容修订；正文（包括错字）、题面、依据与教学图片均计入。
  const text = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\s(?:style|class)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi, '')
  const clean = (items) => items.map(({ createdAt, updatedAt, revision, publishedAt, ...item }) => item).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return hashJson({ text, questions: clean(questions), materials: clean(materials), assets: assets.filter((a) => !/\.(css|m?js|woff2?|ttf|otf)$/i.test(a.path)).map(({ path, sha256 }) => ({ path, sha256 })) })
}

export function snapshotLesson(root, archiveDir, state, lesson) {
  const htmlFile = assertInside(root, path.resolve(root, lesson.path), '课程页面')
  const html = fs.readFileSync(htmlFile)
  if (sha256(html) !== lesson.fingerprint) throw new ValidationError('课程页面已变化，请重新发布后再操作集合：' + lesson.id)
  const questions = Object.values(state.questions).filter((q) => q.lessonId === lesson.id)
  const ids = new Set(questions.flatMap((q) => q.materials ?? []))
  const materials = Object.values(state.materials).filter((m) => ids.has(m.id) || (m.url && html.toString('utf8').includes(m.url)) || (m.kind === 'file' && (m.path === lesson.path || lesson.assets.some((a) => a.path === m.path))))
  const contentVersion = contentFingerprint(html.toString('utf8'), questions, materials, lesson.assets)
  const previous = state.lessonVersions?.[lesson.id]?.[contentVersion]
  const contentRevision = previous?.lesson.revision ?? lesson.revision
  const artifact = hashJson({ fingerprint: lesson.fingerprint, assets: lesson.assets })
  const base = path.join(archiveDir, 'versions', contentVersion, artifact)
  const copy = (relative, expected) => {
    const source = assertInside(root, path.resolve(root, relative), '课程资源')
    const bytes = fs.readFileSync(source)
    if (sha256(bytes) !== expected) throw new ValidationError('课程资源已变化，请重新发布：' + relative)
    const target = path.resolve(base, relative)
    if (!target.startsWith(base + path.sep)) throw new ValidationError('非法课程路径：' + relative)
    const parts = path.relative(archiveDir, path.dirname(target)).split(path.sep)
    let dir = archiveDir
    for (const part of parts) { dir = path.join(dir, part); ensureRealDir(dir) }
    if (!fs.existsSync(target)) atomicWrite(target, bytes)
    else if (sha256(fs.readFileSync(assertInside(base, target))) !== expected) throw new ValidationError('课程快照损坏：' + relative)
  }
  copy(lesson.path, lesson.fingerprint)
  for (const asset of lesson.assets) copy(asset.path, asset.sha256)
  return { contentVersion, artifactRoot: path.relative(root, base).split(path.sep).join('/'), lesson: { ...lesson, revision: contentRevision, contentVersion }, questions, materials }
}

export function versionView(state, scope = {}) {
  const version = scope.contentVersion && state.lessonVersions?.[scope.lessonId]?.[scope.contentVersion]
  if (!version) return state
  const questions = Object.assign(Object.create(null), state.questions)
  for (const q of Object.values(questions)) if (q.lessonId === scope.lessonId) delete questions[q.id]
  for (const q of version.questions) questions[q.id] = q
  return { ...state, lessons: Object.assign(Object.create(null), state.lessons, { [scope.lessonId]: { ...version.lesson, artifactRoot: version.artifactRoot } }), questions, materials: Object.assign(Object.create(null), state.materials, Object.fromEntries(version.materials.map((m) => [m.id, m]))) }
}
