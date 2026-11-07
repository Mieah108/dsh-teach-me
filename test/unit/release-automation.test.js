import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { releaseMetadata, renderReleaseNotes } from '../../scripts/release-notes.mjs'
import { npmPublishPlan } from '../../scripts/publish-npm.mjs'

const pkg = {
  name: 'dsh-teach-me', version: '0.7.4',
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
  repository: { url: 'git+https://github.com/Mieah108/dsh-teach-me.git' }
}

test('public 标签对应稳定 npm 版本，真正的预发布版本使用 next', () => {
  const metadata = releaseMetadata(pkg, '0.7.4-public', 'Mieah108/dsh-teach-me')
  assert.equal(metadata.version, '0.7.4')
  assert.equal(metadata.npmTag, 'latest')
  assert.equal(metadata.prerelease, false)
  const preview = releaseMetadata({ ...pkg, version: '0.8.0-beta.1' }, 'v0.8.0-beta.1')
  assert.equal(preview.npmTag, 'next')
  assert.equal(preview.prerelease, true)
})

test('发布元数据拒绝错误标签、私有包、非公开 registry 和错配仓库', () => {
  assert.throws(() => releaseMetadata(pkg, '0.7.3-public'), /不一致/)
  assert.throws(() => releaseMetadata(pkg, '../../notes'), /不一致/)
  assert.throws(() => releaseMetadata({ ...pkg, private: true }, '0.7.4-public'), /私有包/)
  assert.throws(() => releaseMetadata({ ...pkg, name: '@local/dsh-teach-me' }, '0.7.4-public'), /私有包/)
  assert.throws(() => releaseMetadata({ ...pkg, publishConfig: { access: 'restricted' } }, '0.7.4-public'), /registry/)
  assert.throws(() => releaseMetadata(pkg, '0.7.4-public', 'someone/another-repo'), /仓库/)
})

test('发布说明优先使用独立说明，否则只提取当前 CHANGELOG 版本并补安装命令', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-release-notes-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const metadata = releaseMetadata(pkg, '0.7.4-public')
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- Future\n\n## [0.7.4] - 2026-10-31\n\n- Current\n\n## [0.7.3]\n\n- Old\n')
  const fallback = renderReleaseNotes(root, metadata)
  assert.match(fallback, /Current/)
  assert.doesNotMatch(fallback, /Future|Old/)
  assert.match(fallback, /dsh plugin --profile web add dsh-teach-me@0\.7\.4/)
  fs.mkdirSync(path.join(root, 'docs/releases'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs/releases/0.7.4-public.md'), 'First public release\n')
  assert.equal(renderReleaseNotes(root, metadata), 'First public release\n')
  fs.rmSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '## [0.7.3]\n\n- Old\n')
  assert.throws(() => renderReleaseNotes(root, metadata), /缺少/)
})

test('npm 新版本允许发布，仅在既有版本和 SHA-512 都一致时跳过', () => {
  const input = { version: '0.7.4', integrity: 'sha512-fixture', published: null, latest: null }
  assert.equal(npmPublishPlan(input), 'publish')
  const published = { version: '0.7.4', dist: { integrity: 'sha512-fixture' } }
  assert.equal(npmPublishPlan({ ...input, published }), 'skip')
  assert.throws(() => npmPublishPlan({ ...input, published: { ...published, dist: { integrity: 'sha512-other' } } }), /不一致/)
  assert.throws(() => npmPublishPlan({ ...input, published: { ...published, version: '0.7.3' } }), /不一致/)
})

test('npm 重试也不能降级 latest；预发布进入 next', () => {
  const input = { version: '0.7.4', integrity: 'sha512-fixture', published: null }
  assert.throws(() => npmPublishPlan({ ...input, latest: { version: '0.7.5' } }), /降级/)
  assert.throws(() => npmPublishPlan({ ...input, latest: { version: '0.8.0' }, published: { version: '0.7.4', dist: { integrity: input.integrity } } }), /降级/)
  assert.equal(npmPublishPlan({ ...input, version: '0.8.0', latest: { version: '0.7.99' } }), 'publish')
  assert.equal(npmPublishPlan({ ...input, version: '0.8.0-beta.1', latest: { version: '1.0.0' } }), 'publish')
  assert.throws(() => npmPublishPlan({ ...input, latest: { version: 'invalid' } }), /无法解析/)
})

test('并发或重试的旧 beta 不能把 npm next 指回旧版本', () => {
  const input = { version: '0.9.0-beta.2', integrity: 'sha512-archive' }
  assert.throws(() => npmPublishPlan({ ...input, next: { version: '0.9.0-beta.10' } }), /next 降级/)
  assert.equal(npmPublishPlan({ ...input, next: { version: '0.9.0-beta.1' } }), 'publish')
  const published = { version: input.version, dist: { integrity: input.integrity } }
  assert.equal(npmPublishPlan({ ...input, published, next: published }), 'skip')
})
