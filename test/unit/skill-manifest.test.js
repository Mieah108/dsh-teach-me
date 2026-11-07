import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { checkSkills, updateProjectSkillManifest } from '../../scripts/sync-skills.mjs'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-skill-manifest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.cpSync(source, path.join(root, 'skills'), { recursive: true })
  return root
}

const skillFile = (root, name, file = 'SKILL.md') => path.join(root, 'skills', name, file)
const manifestFile = (root) => path.join(root, 'skills/UPSTREAM.json')

test('技能检查只依赖传入包的完整清单与固定上游身份', (t) => {
  assert.deepEqual(checkSkills(fixture(t)), { teach: 6, 'teach-animation': 1 })
})

for (const name of ['teach', 'teach-animation']) {
  test(name + ' 缺文件时失败', (t) => {
    const root = fixture(t)
    fs.unlinkSync(skillFile(root, name))
    assert.throws(() => checkSkills(root), /缺少|固定上游|空目录/)
  })
  test(name + ' 多出文件时失败', (t) => {
    const root = fixture(t)
    fs.writeFileSync(skillFile(root, name, 'extra.md'), '# Unlisted\n')
    assert.throws(() => checkSkills(root), /固定上游|未登记/)
  })
  test(name + ' 内容被改动时失败', (t) => {
    const root = fixture(t)
    fs.appendFileSync(skillFile(root, name), '\nmodified\n')
    assert.throws(() => checkSkills(root), /固定上游|哈希/)
  })
}

test('改动上游和清单后 --write 仍拒绝，且不改写清单', (t) => {
  const root = fixture(t)
  const file = skillFile(root, 'teach')
  fs.appendFileSync(file, '\nmodified\n')
  const bytes = fs.readFileSync(file)
  const manifest = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8'))
  const item = manifest.skills.teach.files.find((entry) => entry.path === 'SKILL.md')
  item.bytes = bytes.length
  item.sha256 = createHash('sha256').update(bytes).digest('hex')
  item.gitBlobSha = createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex')
  fs.writeFileSync(manifestFile(root), JSON.stringify(manifest))
  const before = fs.readFileSync(manifestFile(root), 'utf8')
  assert.throws(() => updateProjectSkillManifest(root), /固定上游/)
  assert.equal(fs.readFileSync(manifestFile(root), 'utf8'), before)
})

test('只刷新项目技能清单，不复制本机外部技能', (t) => {
  const root = fixture(t)
  const upstreamBefore = fs.readFileSync(skillFile(root, 'teach'))
  const filesBefore = JSON.parse(fs.readFileSync(manifestFile(root), 'utf8')).skills.teach
  fs.appendFileSync(skillFile(root, 'teach-animation'), '\nProject-specific change.\n')
  assert.throws(() => checkSkills(root), /哈希/)
  assert.deepEqual(updateProjectSkillManifest(root), { teach: 6, 'teach-animation': 1 })
  assert.deepEqual(fs.readFileSync(skillFile(root, 'teach')), upstreamBefore)
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile(root), 'utf8')).skills.teach, filesBefore)
})

test('未登记技能和空目录均拒绝', (t) => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, 'skills/unlisted'))
  assert.throws(() => checkSkills(root), /未登记/)
  fs.rmdirSync(path.join(root, 'skills/unlisted'))
  fs.mkdirSync(path.join(root, 'skills/teach-animation/empty'))
  assert.throws(() => updateProjectSkillManifest(root), /空目录/)
})

test('拒绝链接，避免技能目录包含工作区外文件', (t) => {
  const root = fixture(t)
  const outside = path.join(root, 'outside.md')
  fs.writeFileSync(outside, 'outside')
  fs.symlinkSync(outside, skillFile(root, 'teach-animation', 'linked.md'))
  assert.throws(() => checkSkills(root), /普通文件/)
  assert.throws(() => updateProjectSkillManifest(root), /普通文件/)
})

test('清单中路径穿越、重复文件和空文件集均失败', (t) => {
  const root = fixture(t)
  const original = fs.readFileSync(manifestFile(root), 'utf8')
  for (const paths of [['../outside.md'], ['SKILL.md', 'SKILL.md'], []]) {
    const manifest = JSON.parse(original)
    manifest.skills['teach-animation'].files = paths.map((file) => ({ path: file, bytes: 0, sha256: '' }))
    fs.writeFileSync(manifestFile(root), JSON.stringify(manifest))
    assert.throws(() => checkSkills(root), /路径无效|文件缺失|逐文件清单/)
  }
})
