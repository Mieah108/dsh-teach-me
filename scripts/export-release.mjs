#!/usr/bin/env node
/** Export reviewed filesystem snapshots; never copies .git or invokes Git mutations. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkRelease, publicFiles } from './check-release.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const contains = (root, candidate) => {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}
function canonicalDestination(destination) {
  let existing = path.resolve(destination)
  const suffix = []
  while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); existing = path.dirname(existing) }
  return path.join(fs.realpathSync(existing), ...suffix)
}
function copyFiles(files, source, destination) {
  for (const file of files) {
    if (/[\r\n]/.test(file)) throw new Error('发布路径不能包含换行')
    const target = path.join(destination, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, file), target)
  }
}
function manifest(files, root) {
  return files.map((file) => ({ path: file, bytes: fs.statSync(path.join(root, file)).size, sha256: hash(fs.readFileSync(path.join(root, file))) }))
}

/** Inspect every tar header and data block, including entries a filesystem filter would hide. */
export function verifyArchive(archive, prefix, files, { source = false } = {}) {
  const compressed = fs.readFileSync(archive)
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 8 || (compressed[3] & 28)) throw new Error('归档 gzip 含非标准元数据')
  const tar = gunzipSync(compressed)
  const expected = new Map(files.map((row) => [prefix + '/' + row.path, row]))
  const directories = new Set([prefix])
  for (const name of expected.keys()) {
    let parent = path.posix.dirname(name)
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent) }
  }
  const seen = new Set()
  const seenFiles = new Set()
  const string = (header, start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0]
  const octal = (header, start, length) => {
    const value = string(header, start, length).trim()
    if (value && !/^[0-7]+$/.test(value)) throw new Error('不支持的 tar 数字字段')
    return value ? Number.parseInt(value, 8) : 0
  }
  let offset = 0
  let ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > tar.length || tar.subarray(offset).some((byte) => byte !== 0)) throw new Error('tar 结束块后存在额外数据')
      ended = true
      break
    }
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (checksum !== octal(header, 148, 8)) throw new Error('tar 头校验和不符')
    const namePart = string(header, 0, 100)
    const parentPart = string(header, 345, 155)
    const name = (parentPart ? parentPart + '/' : '') + namePart
    const normalized = name.replace(/\/$/, '')
    const type = string(header, 156, 1) || '0'
    const size = octal(header, 124, 12)
    if (!['0', '5'].includes(type) || string(header, 157, 100)) throw new Error('归档含链接或扩展元数据：' + name)
    if (path.posix.normalize(normalized) !== normalized || normalized.split('/').some((part) => part === '.DS_Store' || part.startsWith('._'))) throw new Error('归档含本地元数据或异常路径：' + name)
    if (seen.has(normalized)) throw new Error('归档重复条目：' + name)
    seen.add(normalized)
    if (octal(header, 108, 8) !== 0 || octal(header, 116, 8) !== 0 || !['', 'root'].includes(string(header, 265, 32)) || !['', 'root'].includes(string(header, 297, 32))) throw new Error('归档含本机所有者信息：' + name)
    if (source && octal(header, 136, 12) !== 0) throw new Error('源码归档时间未归一化：' + name)
    const dataStart = offset + 512
    if (dataStart + size > tar.length) throw new Error('归档数据被截断：' + name)
    if (type === '5') {
      if (!directories.has(normalized) || size !== 0) throw new Error('归档额外目录：' + name)
    } else {
      const expectedFile = expected.get(normalized)
      if (!expectedFile || expectedFile.bytes !== size || hash(tar.subarray(dataStart, dataStart + size)) !== expectedFile.sha256) throw new Error('归档文件不在清单内或内容不符：' + name)
      seenFiles.add(normalized)
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  if (!ended || seenFiles.size !== expected.size) throw new Error('归档缺少文件或结束块')
  return { entries: seen.size, files: seenFiles.size }
}

function normalizedSourceTar(sourceRoot, archive, work) {
  const normalize = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) normalize(file)
      else { fs.chmodSync(file, 0o644); fs.utimesSync(file, 0, 0) }
    }
    fs.chmodSync(directory, 0o755)
    fs.utimesSync(directory, 0, 0)
  }
  normalize(sourceRoot)
  const tarVersion = execFileSync('tar', ['--version'], { encoding: 'utf8' })
  const platformFlags = /bsdtar/.test(tarVersion)
    ? ['--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags', '--uid=0', '--gid=0', '--uname=root', '--gname=root']
    : /GNU tar/.test(tarVersion)
      ? ['--no-xattrs', '--no-acls', '--owner=0', '--group=0', '--numeric-owner']
      : null
  if (!platformFlags) throw new Error('源码导出需要 bsdtar 或 GNU tar')
  const raw = path.join(work, 'source.tar')
  execFileSync('tar', ['--format=ustar', ...platformFlags, '-cf', raw, '-C', work, '--', path.basename(sourceRoot)], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  fs.writeFileSync(archive, gzipSync(fs.readFileSync(raw), { level: 9 }))
}

export async function exportRelease(output, root = ROOT) {
  root = fs.realpathSync(root)
  output = canonicalDestination(output)
  if (contains(root, output)) throw new Error('发布输出必须在源码目录之外')
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0) throw new Error('发布输出目录必须为空')
  const checked = await checkRelease(root)
  if (!checked.ok) throw new Error(checked.errors.join('\n'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-release-'))
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const sourceName = `dsh-teach-me-${pkg.version}-source`
    const sourceRoot = path.join(work, sourceName)
    const runtimeRoot = path.join(work, 'runtime')
    const generated = path.join(work, 'generated')
    fs.mkdirSync(generated)
    copyFiles(checked.files, root, sourceRoot)
    const copiedSourceCheck = await checkRelease(sourceRoot)
    if (!copiedSourceCheck.ok) throw new Error(copiedSourceCheck.errors.join('\n'))
    const sourceManifest = manifest(checked.files, sourceRoot)
    fs.writeFileSync(path.join(sourceRoot, 'SOURCE-MANIFEST.json'), JSON.stringify({ version: pkg.version, files: sourceManifest }, null, 2) + '\n')
    const runtimeFiles = publicFiles(root, { runtime: true })
    copyFiles(runtimeFiles, root, runtimeRoot)
    // The installed payload exposes runtime CLIs, not source-only maintenance commands.
    const runtimePackage = { ...pkg }
    delete runtimePackage.scripts
    delete runtimePackage.devDependencies
    delete runtimePackage.packageManager
    fs.writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n')
    const runtimeChecked = await checkRelease(runtimeRoot, { runtime: true })
    if (!runtimeChecked.ok) throw new Error(runtimeChecked.errors.join('\n'))
    const packResult = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', generated], {
      cwd: runtimeRoot, encoding: 'utf8', env: { ...process.env, npm_config_cache: path.join(work, 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe']
    }))[0]
    const actualFiles = packResult.files.map((entry) => entry.path).sort()
    if (JSON.stringify(actualFiles) !== JSON.stringify(runtimeFiles)) throw new Error('实际 npm 内容与运行时白名单不一致')
    const runtimeManifest = manifest(runtimeFiles, runtimeRoot)
    const runtimeArchiveCheck = verifyArchive(path.join(generated, packResult.filename), 'package', runtimeManifest)
    const unpack = path.join(work, 'unpack')
    fs.mkdirSync(unpack)
    execFileSync('tar', ['-xzf', path.join(generated, packResult.filename), '-C', unpack])
    const unpackedCheck = await checkRelease(path.join(unpack, 'package'), { runtime: true })
    if (!unpackedCheck.ok) throw new Error(unpackedCheck.errors.join('\n'))
    const sourceArchive = sourceName + '.tar.gz'
    normalizedSourceTar(sourceRoot, path.join(generated, sourceArchive), work)
    const completeSourceFiles = [...sourceManifest, ...manifest(['SOURCE-MANIFEST.json'], sourceRoot)]
    const sourceArchiveCheck = verifyArchive(path.join(generated, sourceArchive), sourceName, completeSourceFiles, { source: true })
    fs.writeFileSync(path.join(generated, 'release-manifest.json'), JSON.stringify({
      packageName: pkg.name,
      version: pkg.version,
      source: { archive: sourceArchive, files: completeSourceFiles, archiveEntries: sourceArchiveCheck.entries },
      runtime: { archive: packResult.filename, files: runtimeManifest, archiveEntries: runtimeArchiveCheck.entries },
      historyIncluded: false
    }, null, 2) + '\n')
    const outputs = fs.readdirSync(generated).sort()
    fs.writeFileSync(path.join(generated, 'SHA256SUMS'), outputs.map((name) => `${hash(fs.readFileSync(path.join(generated, name)))}  ${name}`).join('\n') + '\n')
    fs.mkdirSync(output, { recursive: true })
    for (const file of fs.readdirSync(generated)) fs.copyFileSync(path.join(generated, file), path.join(output, file), fs.constants.COPYFILE_EXCL)
    return { version: pkg.version, sourceFiles: checked.files.length, runtimeFiles: actualFiles.length, output }
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('-')) throw new Error('用法：node scripts/export-release.mjs --output <仓库外的空目录>')
  const result = await exportRelease(args[1])
  console.log(`✓ 已导出 ${result.version}：源码 ${result.sourceFiles} 文件，运行时 ${result.runtimeFiles} 文件；${result.output}`)
}
