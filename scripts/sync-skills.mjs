#!/usr/bin/env node
/** Check bundled files without reading HOME. --write refreshes only project-owned files. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEACH_COMMIT = 'ad5400b930b297b0c0cb231ff1ffe42a7da666aa'
// GitHub blob identities verified at TEACH_COMMIT. Updating this snapshot is an explicit source review.
const TEACH_BLOBS = {
  'GLOSSARY-FORMAT.md': 'fdd7e366ad9760588b28981e42b3d3b561e56aca',
  'LEARNING-RECORD-FORMAT.md': '953c61422776b47612c3c945920358ad7b5daee7',
  'MISSION-FORMAT.md': '45250bb1bad70988bf381625931df64645e10246',
  'RESOURCES-FORMAT.md': '18b588c8b6f96a50ae2352f264928c643d2782e4',
  'SKILL.md': '493fa3bae0dada971c4dfb965790e56920b1dced',
  'agents/openai.yaml': '3452a850e3b0c1f0a3d41b2bfd45164d2d38d7f6'
}
const SKILLS = ['teach', 'teach-animation']
const digest = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex')

function regularFiles(directory) {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('技能目录无效：' + directory)
  const files = []
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    if (entries.length === 0) throw new Error('技能包含空目录：' + current)
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(path.relative(directory, full).split(path.sep).join('/'))
      else throw new Error('技能只允许普通文件与目录：' + full)
    }
  }
  walk(directory)
  return files.sort()
}

function readManifest(root) {
  const directory = path.join(root, 'skills')
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('技能根必须是普通目录')
  const file = path.join(directory, 'UPSTREAM.json')
  if (!fs.lstatSync(file).isFile()) throw new Error('技能清单必须是普通文件')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (manifest.schemaVersion !== 2 || manifest.skills === null || typeof manifest.skills !== 'object') {
    throw new Error('技能清单必须采用 schemaVersion 2')
  }
  if (JSON.stringify(Object.keys(manifest.skills).sort()) !== JSON.stringify(SKILLS)) throw new Error('技能清单目录集合不符')
  const entries = fs.readdirSync(directory).sort()
  if (JSON.stringify(entries) !== JSON.stringify(['UPSTREAM.json', ...SKILLS].sort())) throw new Error('skills 根含未登记文件或目录')
  const teach = manifest.skills.teach
  if (teach.origin !== 'upstream' || teach.commit !== TEACH_COMMIT || teach.license !== 'MIT' ||
    teach.upstream !== 'https://github.com/mattpocock/skills' || teach.path !== 'skills/productivity/teach') {
    throw new Error('teach 上游来源与固定提交不符')
  }
  const project = manifest.skills['teach-animation']
  if (project.origin !== 'project' || project.license !== 'BSD-3-Clause') throw new Error('teach-animation 必须声明项目来源与许可')
  return { manifest, file, directory }
}

function inventory(directory, name) {
  const skillDir = path.join(directory, name)
  return regularFiles(skillDir).map((file) => {
    const bytes = fs.readFileSync(path.join(skillDir, file))
    return {
      path: file,
      bytes: bytes.length,
      sha256: digest(bytes),
      ...(name === 'teach' ? { gitBlobSha: digest(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes]), 'sha1') } : {})
    }
  })
}

function validateFiles(name, declared, actual) {
  if (!Array.isArray(declared) || declared.length === 0) throw new Error(name + ' 缺少逐文件清单')
  const paths = declared.map((item) => item?.path)
  if (paths.some((file) => typeof file !== 'string' || file.length === 0 || file.includes('\\') || file.startsWith('/') || file.split('/').some((part) => part === '.' || part === '..' || part === ''))) {
    throw new Error(name + ' 清单路径无效')
  }
  if (new Set(paths).size !== paths.length || JSON.stringify([...paths].sort()) !== JSON.stringify(actual.map((item) => item.path))) {
    throw new Error(name + ' 文件缺失或含未登记文件')
  }
  for (const item of actual) {
    const expected = declared.find((entry) => entry.path === item.path)
    if (expected.bytes !== item.bytes || expected.sha256 !== item.sha256 || (name === 'teach' && expected.gitBlobSha !== item.gitBlobSha)) {
      throw new Error(name + '/' + item.path + ' 与清单哈希不符')
    }
  }
}

function validateTeach(actual) {
  if (JSON.stringify(actual.map((item) => item.path)) !== JSON.stringify(Object.keys(TEACH_BLOBS).sort())) {
    throw new Error('teach 文件集合与固定上游提交不符')
  }
  for (const item of actual) {
    if (item.gitBlobSha !== TEACH_BLOBS[item.path]) throw new Error('teach/' + item.path + ' 与固定上游提交不符')
  }
}

export function checkSkills(root = ROOT) {
  const { manifest, directory } = readManifest(root)
  const counts = {}
  for (const name of SKILLS) {
    const actual = inventory(directory, name)
    if (!actual.some((item) => item.path === 'SKILL.md')) throw new Error(name + ' 缺少 SKILL.md')
    if (name === 'teach') validateTeach(actual)
    validateFiles(name, manifest.skills[name].files, actual)
    counts[name] = actual.length
  }
  return counts
}

export function updateProjectSkillManifest(root = ROOT) {
  const { manifest, file, directory } = readManifest(root)
  const teach = inventory(directory, 'teach')
  validateTeach(teach)
  validateFiles('teach', manifest.skills.teach.files, teach)
  const project = inventory(directory, 'teach-animation')
  if (!project.some((item) => item.path === 'SKILL.md')) throw new Error('teach-animation 缺少 SKILL.md')
  manifest.skills['teach-animation'].files = project
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  return checkSkills(root)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.some((arg) => !['--check', '--write'].includes(arg)) || args.length > 1) throw new Error('用法：node scripts/sync-skills.mjs [--check|--write]')
    const counts = args.includes('--write') ? updateProjectSkillManifest() : checkSkills()
    for (const [name, count] of Object.entries(counts)) console.log('✓ 技能清单一致：' + name + '（' + count + ' 个文件）')
  } catch (error) {
    console.error('✗ ' + error.message)
    process.exitCode = 1
  }
}
