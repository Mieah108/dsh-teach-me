#!/usr/bin/env node
/** Render release metadata and notes locally; never creates a remote release. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function releaseMetadata(pkg, tag, repository) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('无效的 npm 版本号')
  if (!['v' + pkg.version, pkg.version + '-public'].includes(tag)) throw new Error('Release 标签与 package.json 版本不一致')
  if (pkg.private || pkg.name.startsWith('@local/')) throw new Error('本地私有包不能发布')
  if (pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') throw new Error('缺少公开 npm registry 配置')
  const source = pkg.repository?.url?.match(/^git\+https:\/\/github\.com\/([^/]+\/[^/]+)\.git$/)?.[1]
  if (!source || (repository && source.toLowerCase() !== repository.toLowerCase())) throw new Error('GitHub 仓库与 package.json 不一致')
  const prerelease = pkg.version.includes('-')
  return { tag, version: pkg.version, packageName: pkg.name, repository: source, title: `教学模式 ${tag}`, prerelease, npmTag: prerelease ? 'next' : 'latest' }
}

export function renderReleaseNotes(root, metadata) {
  const custom = path.join(root, 'docs/releases', metadata.tag + '.md')
  if (fs.existsSync(custom)) return fs.readFileSync(custom, 'utf8').trimEnd() + '\n'
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  const sections = changelog.split(/^## /m).slice(1)
  const section = sections.find((text) => text.startsWith(`[${metadata.version}]`))
  if (!section) throw new Error('CHANGELOG 缺少当前版本说明')
  const body = section.slice(section.indexOf('\n') + 1).trim()
  if (!body) throw new Error('当前版本的更新说明为空')
  return `${body}\n\n## 安装与升级\n\n\`\`\`sh\ndsh plugin --profile web add ${metadata.packageName}@${metadata.version}\n\`\`\`\n\n更新后重启 DeepSeek Harness 并刷新客户端，在新会话中选择「教学模式」。\n\n[完整更新日志](https://github.com/${metadata.repository}/blob/${metadata.tag}/CHANGELOG.md)\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--tag' || args[2] !== '--output' || !args[1] || !args[3]) throw new Error('用法：node scripts/release-notes.mjs --tag <tag> --output <notes.md>')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const metadata = releaseMetadata(pkg, args[1], process.env.GITHUB_REPOSITORY)
  const output = path.resolve(args[3])
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, renderReleaseNotes(ROOT, metadata))
  if (process.env.GITHUB_OUTPUT) {
    const values = { title: metadata.title, version: metadata.version, package_name: metadata.packageName, npm_tag: metadata.npmTag, prerelease: metadata.prerelease }
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''))
  }
  console.log(JSON.stringify({ ...metadata, notes: output }, null, 2))
}
