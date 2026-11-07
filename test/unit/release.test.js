import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { verifyArchive } from '../../scripts/export-release.mjs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { SOURCE_FILES, SOURCE_DIRS, inspectText, publicFiles } from '../../scripts/check-release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-release-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const name of SOURCE_FILES) fs.writeFileSync(path.join(dir, name), 'fixture')
  for (const name of SOURCE_DIRS) fs.mkdirSync(path.join(dir, name))
  return dir
}

test('公开文件枚举只选白名单，忽略本地状态且拒绝嵌套秘密', (t) => {
  const dir = fixture(t)
  fs.writeFileSync(path.join(dir, 'local-personal.txt'), 'private')
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, 'docs', 'public.md'), '# Public')
  assert.ok(publicFiles(dir).includes('docs/public.md'))
  assert.equal(publicFiles(dir).includes('local-personal.txt'), false)
  fs.writeFileSync(path.join(dir, 'docs', '.env'), 'LOCAL_VALUE=example')
  assert.throws(() => publicFiles(dir), /敏感文件/)
  fs.rmSync(path.join(dir, 'docs', '.env'))
  fs.writeFileSync(path.join(dir, 'docs', '.env.example'), 'LOCAL_VALUE=example')
  assert.ok(publicFiles(dir).includes('docs/.env.example'))
})

test('公开枚举拒绝指向仓库外的符号链接', (t) => {
  const dir = fixture(t)
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'docs', 'linked'))
  assert.throws(() => publicFiles(dir), /符号链接/)
})

test('公开枚举拒绝嵌套学习档案、机器配置与归档备份', (t) => {
  const dir = fixture(t)
  for (const relative of ['docs/.dsh-teach-me/archive.json', 'docs/.teach/state.json', 'docs/_teach-managed/registry.json', 'docs/.npmrc', 'docs/.pypirc', 'docs/profile.local.json', 'docs/profile.local.yml', 'docs/profile.local.yaml', 'docs/backup.tar.gz']) {
    const target = path.join(dir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'fixture')
    assert.throws(() => publicFiles(dir), /敏感文件/, relative)
    fs.rmSync(path.join(dir, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'docs'))
  }
})

test('发布扫描拒绝机器目录、真实会话形状和凭据，保留系统路径及明确测试反例', () => {
  const personal = '/' + ['Users', 'example-owner', 'work'].join('/')
  const token = 'sk-' + 'abcdefgh1234567890abcdef'
  const session = 'session-' + '12345678-1234-1234-1234-123456789abc'
  assert.match(inspectText('README.md', personal).join(), /个人目录/)
  for (const pieces of [['home', 'alice', 'projects', 'demo'], ['root', 'work', 'private'], ['home', 'nobody-else', 'work'], ['home', 'nobody', 'secrets']]) {
    assert.match(inspectText('README.md', '/' + pieces.join('/')).join(), /Linux 个人目录/)
  }
  assert.match(inspectText('README.md', token).join(), /凭据格式/)
  assert.match(inspectText('README.md', 'api_key=' + '"' + 'abc1234567890123456789' + '"').join(), /凭据字面量/)
  assert.match(inspectText('README.md', 'https://example.org/?' + 'token=abc1234567890123456789').join(), /查询凭据/)
  assert.match(inspectText('README.md', session).join(), /真实会话/)
  assert.deepEqual(inspectText('lib/system.js', '/usr/bin/node /Users/Shared /home/nobody'), [])
  const badUrl = 'https://' + 'user:pass@example.org/x'
  assert.deepEqual(inspectText('test/unit/url.test.js', badUrl), [])
  assert.match(inspectText('README.md', badUrl).join(), /内嵌凭据/)
})

test('版本源码校验可在没有 Git 的归档中运行，不能冒充 tag 校验', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-version-source-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'scripts'))
  const script = path.join(dir, 'scripts', 'version.mjs')
  fs.copyFileSync(path.join(root, 'scripts/version.mjs'), script)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', version: '0.7.3', engines: { dsh: '>=0.2.1-rc.3' }, scripts: { verify: 'node scripts/verify.mjs' } }))
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '## [0.7.3] - 2026-10-31\n')
  const result = spawnSync(process.execPath, [script, 'verify', '--source'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /未检查 Git/)
  const conflict = spawnSync(process.execPath, [script, 'verify', '--source', '--release'], { encoding: 'utf8' })
  assert.equal(conflict.status, 1)
  assert.match(conflict.stderr, /不能同时使用/)
})

for (const { tag, dirty = false, error } of [
  { tag: '0.7.4-public' },
  { tag: 'v0.7.4' },
  { tag: '0.7.3-public', error: /不一致/ },
  { tag: null, error: /要求 HEAD/ },
  { tag: '0.7.4-public', dirty: true, error: /干净工作区/ }
]) {
  test(`发布校验：${tag ?? '无标签'}${dirty ? '，存在未提交修改' : ''}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-release-tag-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.mkdirSync(path.join(dir, 'scripts'))
    const script = path.join(dir, 'scripts', 'version.mjs')
    fs.copyFileSync(path.join(root, 'scripts/version.mjs'), script)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', version: '0.7.4', engines: { dsh: '>=0.2.1-rc.3' }, scripts: { verify: 'node scripts/verify.mjs' } }))
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '## [0.7.4] - 2026-10-31\n')
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
    const git = (...args) => {
      const result = spawnSync('git', ['-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { cwd: dir, env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    git('init', '--quiet')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    if (tag) git('tag', '-a', tag, '-m', 'fixture')
    if (dirty) fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), '\nchanged\n')
    const result = spawnSync(process.execPath, [script, 'verify', '--release'], { cwd: dir, env, encoding: 'utf8' })
    if (error) {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, error)
    } else {
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, new RegExp(tag.replaceAll('.', '\\.')))
    }
  })
}

test('公开检查 CLI 拒绝未知参数和缺失 root 值', () => {
  for (const args of [['--unknown'], ['--root'], ['--root', '--unknown']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/check-release.mjs'), ...args], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /用法/)
  }
})

test('导出拒绝仓库内路径及有内容的输出目录，保留已有文件', async (t) => {
  const { exportRelease } = await import('../../scripts/export-release.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-release-output-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const alias = path.join(dir, 'source-alias')
  fs.symlinkSync(root, alias)
  await assert.rejects(exportRelease(path.join(alias, 'artifacts')), /源码目录之外/)
  const output = path.join(dir, 'output')
  fs.mkdirSync(output)
  fs.writeFileSync(path.join(output, 'keep.txt'), 'keep')
  await assert.rejects(exportRelease(output), /必须为空/)
  assert.equal(fs.readFileSync(path.join(output, 'keep.txt'), 'utf8'), 'keep')
})


// Minimal USTAR fixtures exercise headers hidden by ordinary extracted-file enumeration.
function tarEntry(name, content = '', { type = '0', uid = 0, user = 'root' } = {}) {
  const bytes = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  const octal = (offset, width, value) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width)
  octal(100, 8, type === '5' ? 0o755 : 0o644)
  octal(108, 8, uid)
  octal(116, 8, 0)
  octal(124, 12, bytes.length)
  octal(136, 12, 0)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(user, 265, 32)
  header.write('root', 297, 32)
  const sum = [...header].reduce((total, value) => total + value, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}

test('实际 tar 校验覆盖 AppleDouble、扩展头、所有者、额外文件和内容变更', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-tar-header-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'source.tar.gz')
  const data = 'public source'
  const rows = [{ path: 'README.md', bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex') }]
  const rootEntry = tarEntry('source/', '', { type: '5' })
  const fileEntry = tarEntry('source/README.md', data)
  const write = (entries) => fs.writeFileSync(target, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])))
  write([rootEntry, fileEntry])
  assert.deepEqual(verifyArchive(target, 'source', rows, { source: true }), { entries: 2, files: 1 })
  const variants = [
    [tarEntry('source/._README.md', 'metadata'), /本地元数据/],
    [tarEntry('source/PaxHeader', 'xattr=data', { type: 'x' }), /扩展元数据/],
    [tarEntry('source/extra.txt', 'unexpected'), /不在清单/],
    [tarEntry('source/link', '', { type: '2' }), /链接/],
    [tarEntry('source/README.md', data, { uid: 501, user: 'local-developer' }), /所有者/, true],
    [tarEntry('source/README.md', 'changed bytes'), /内容不符/, true],
    [fileEntry, /重复条目/]
  ]
  for (const [entry, expected, replacement = false] of variants) {
    write(replacement ? [rootEntry, entry] : [rootEntry, fileEntry, entry])
    assert.throws(() => verifyArchive(target, 'source', rows, { source: true }), expected)
  }
})
