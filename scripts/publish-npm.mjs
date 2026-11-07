#!/usr/bin/env node
/**
 * Publish only the verified runtime tarball. Default mode is an npm dry run.
 * Provenance is on by default; pass --no-provenance when publishing from a
 * private repository, where npm cannot generate an attestation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyArchive } from './export-release.mjs'
import { releaseMetadata } from './release-notes.mjs'
import { compareVersions } from './version.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://registry.npmjs.org/'

export function npmPublishPlan({ version, integrity, published, latest, next }) {
  const prerelease = version.includes('-')
  const channel = prerelease ? 'next' : 'latest'
  const tagged = prerelease ? next : latest
  if (tagged) {
    let comparison
    try { comparison = compareVersions(version, tagged.version) } catch {
      throw new Error('无法解析 npm ' + channel + ' 版本')
    }
    if (comparison < 0) throw new Error('拒绝把 npm ' + channel + ' 降级到旧版本')
  }
  if (published) {
    if (published.version !== version || published.dist?.integrity !== integrity) throw new Error('npm 已存在同版本，但归档内容不一致；拒绝覆盖或跳过')
    return 'skip'
  }
  return 'publish'
}

async function registryVersion(name, version) {
  const response = await fetch(REGISTRY + encodeURIComponent(name) + '/' + encodeURIComponent(version), { signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('npm registry 查询失败：HTTP ' + response.status)
  return response.json()
}

export async function publishNpm(directory, { publish = false, provenance = true } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const repository = publish ? process.env.GITHUB_REPOSITORY : undefined
  const metadata = releaseMetadata(pkg, pkg.version + '-public', repository)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'))
  if (manifest.packageName !== pkg.name || manifest.version !== pkg.version) throw new Error('发行归档与当前包名/版本不一致')
  const filename = manifest.runtime.archive
  if (path.basename(filename) !== filename || !filename.endsWith('.tgz')) throw new Error('无效的运行包文件名')
  const archive = path.resolve(directory, filename)
  verifyArchive(archive, 'package', manifest.runtime.files)
  const packed = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
  if (packed.name !== pkg.name || packed.version !== pkg.version || packed.private) throw new Error('运行包元数据不允许发布')
  releaseMetadata(packed, pkg.version + '-public', repository)
  const integrity = 'sha512-' + createHash('sha512').update(fs.readFileSync(archive)).digest('base64')
  if (publish) {
    const [published, tagged] = await Promise.all([registryVersion(pkg.name, pkg.version), registryVersion(pkg.name, metadata.npmTag)])
    if (npmPublishPlan({ version: pkg.version, integrity, published, [metadata.npmTag]: tagged }) === 'skip') {
      console.log('✓ npm 同版本归档完整性一致，跳过重复发布（不移动 dist-tag）')
      return
    }
  }
  const args = ['publish', archive, '--access', 'public', '--tag', metadata.npmTag, '--registry', REGISTRY, '--ignore-scripts']
  if (publish) args.push(provenance ? '--provenance' : '--no-provenance')
  // 演练只检查归档。真实发布分支负责比较 registry 版本和完整性，重跑时也一样。
  else args.push('--dry-run', '--offline', '--force')
  execFileSync('npm', args, { stdio: 'inherit' })
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = '用法：node scripts/publish-npm.mjs --directory <发行目录> [--dry-run|--publish] [--no-provenance]'
  const args = process.argv.slice(2)
  const flags = args.slice(2)
  const modes = flags.filter((flag) => flag === '--publish' || flag === '--dry-run')
  if (args.length < 2 || args[0] !== '--directory' || !args[1]) throw new Error(usage)
  if (flags.some((flag) => !['--publish', '--dry-run', '--no-provenance'].includes(flag)) || modes.length > 1) throw new Error(usage)
  await publishNpm(args[1], { publish: modes[0] === '--publish', provenance: !flags.includes('--no-provenance') })
}
