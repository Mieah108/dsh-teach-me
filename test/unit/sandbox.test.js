import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openProject } from '../../lib/sandbox.js'

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-project-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-outside-'))
  return {
    root,
    outside,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  }
}

test('白名单内的文件可以写入，且走原子替换', () => {
  const fixture = workspace()
  try {
    fs.mkdirSync(path.join(fixture.root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(fixture.root, 'src', 'Root.tsx'), 'export const Root = 1\n')
    const project = openProject(fixture.root)
    project.write('src/videos/Cat/lesson/Scene.tsx', 'export const Scene = 1\n')
    assert.equal(fs.readFileSync(path.join(fixture.root, 'src/videos/Cat/lesson/Scene.tsx'), 'utf8'), 'export const Scene = 1\n')
    assert.deepEqual(fs.readdirSync(path.join(fixture.root, 'src/videos/Cat/lesson')), ['Scene.tsx'])
    assert.equal(project.checkWritable('out/Cat/demo.mp4'), 'out/Cat/demo.mp4')
  } finally {
    fixture.cleanup()
  }
})

test('out 目录整体是软链时 checkWritable 拒绝（审计 A3）', () => {
  const fixture = workspace()
  try {
    fs.symlinkSync(fixture.outside, path.join(fixture.root, 'out'), 'dir')
    const project = openProject(fixture.root)
    assert.throws(() => project.checkWritable('out/LLM/demo.mp4'), /symlink|软链|工程外/)
  } finally {
    fixture.cleanup()
  }
})

test('断链的中间目录拒绝写入', () => {
  const fixture = workspace()
  try {
    fs.mkdirSync(path.join(fixture.root, 'src', 'videos'), { recursive: true })
    fs.symlinkSync(path.join(fixture.outside, 'missing'), path.join(fixture.root, 'src/videos/Cat'))
    const project = openProject(fixture.root)
    assert.throws(() => project.write('src/videos/Cat/lesson/Scene.tsx', 'x'), /软链|断/)
  } finally {
    fixture.cleanup()
  }
})

test('指向工程外的目录软链拒绝写入', () => {
  const fixture = workspace()
  try {
    fs.mkdirSync(path.join(fixture.root, 'src', 'videos'), { recursive: true })
    fs.symlinkSync(fixture.outside, path.join(fixture.root, 'src/videos/Cat'), 'dir')
    const project = openProject(fixture.root)
    assert.throws(() => project.write('src/videos/Cat/lesson/Scene.tsx', 'x'), /工程外|symlink/)
  } finally {
    fixture.cleanup()
  }
})

test('目标是硬链接时拒绝写入', () => {
  const fixture = workspace()
  try {
    const outsideFile = path.join(fixture.outside, 'shared.mp4')
    fs.writeFileSync(outsideFile, 'outside')
    fs.mkdirSync(path.join(fixture.root, 'out', 'LLM'), { recursive: true })
    fs.linkSync(outsideFile, path.join(fixture.root, 'out/LLM/demo.mp4'))
    const project = openProject(fixture.root)
    assert.throws(() => project.write('out/LLM/demo.mp4', 'inside'), /硬链接|hardlink/)
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside')
  } finally {
    fixture.cleanup()
  }
})

test('目标是断链软链时拒绝写入', () => {
  const fixture = workspace()
  try {
    fs.mkdirSync(path.join(fixture.root, 'out', 'LLM'), { recursive: true })
    fs.symlinkSync(path.join(fixture.outside, 'nope.mp4'), path.join(fixture.root, 'out/LLM/demo.mp4'))
    const project = openProject(fixture.root)
    assert.throws(() => project.write('out/LLM/demo.mp4', 'x'), /软链|断/)
  } finally {
    fixture.cleanup()
  }
})

test('点段、绝对路径与白名单外路径都被拒', () => {
  const fixture = workspace()
  try {
    const project = openProject(fixture.root)
    assert.throws(() => project.resolveInside('../escape.ts'), /../)
    assert.throws(() => project.resolveInside('/etc/passwd'), /绝对路径/)
    assert.throws(() => project.checkWritable('src/main.ts'), /白名单/)
    assert.throws(() => project.checkWritable('src/videos/Cat/lesson/Scene.exe'), /白名单/)
  } finally {
    fixture.cleanup()
  }
})
