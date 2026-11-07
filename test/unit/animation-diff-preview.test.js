import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  ROOT_INTEGRATION_DIFF_HEADER,
  registerManagedNamespace,
  rootIntegrationDiff,
  unifiedDiff
} from '../../lib/animation-managed.js'

const INDEX_TS = ["import { registerRoot } from 'remotion'", "import { RemotionRoot } from './Root'", '', 'registerRoot(RemotionRoot)', ''].join('\n')

const ROOT_TSX = [
  "import { Composition } from 'remotion'",
  '',
  'export const RemotionRoot: React.FC = () => {',
  '  return (',
  '    <>',
  '      <Composition id="OldVideo" component={OldVideo} durationInFrames={90} fps={30} width={1920} height={1080} />',
  '    </>',
  '  )',
  '}',
  ''
].join('\n')

function makeMinimalProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-diff-project-'))
  const root = path.join(base, 'project')
  fs.mkdirSync(root)
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo-project', dependencies: { remotion: '4.0.0', '@remotion/cli': '4.0.0' } })
  )
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), INDEX_TS)
  fs.writeFileSync(path.join(root, 'src', 'Root.tsx'), ROOT_TSX)
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'remotion'), '#!/bin/sh\nexit 0\n')
  return {
    root,
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true })
    }
  }
}

test('root-integration diff 首行固定是「预览稿，非可应用补丁」抬头', () => {
  assert.match(ROOT_INTEGRATION_DIFF_HEADER, /预览稿，非可应用补丁/)
  assert.equal(rootIntegrationDiff('same\n', 'same\n'), '')

  const diff = rootIntegrationDiff('a\nb\nc\n', 'a\nB\nc\n', 'src/Root.tsx')
  assert.equal(diff.split('\n')[0], ROOT_INTEGRATION_DIFF_HEADER)
  assert.match(diff, /--- a\/src\/Root\.tsx/)
  assert.match(diff, /-b/)
  assert.match(diff, /\+B/)

  // unifiedDiff 本身仍是纯 diff（不偷偷改测试/解析器期望的形状）
  assert.match(unifiedDiff('a\n', 'b\n'), /^--- /)
})

test('register 的 dry_run diff 从抬头开始：接入预览不是可直接应用的补丁', () => {
  const project = makeMinimalProject()
  try {
    const result = registerManagedNamespace({ config: { animation: { enabled: true, root: project.root } } })
    assert.equal(result.dryRun, true)
    assert.equal(result.written, false)
    assert.equal(result.diff.split('\n')[0], ROOT_INTEGRATION_DIFF_HEADER)
    assert.match(result.diff, /\+.*<teach-managed:begin>/)
    assert.match(result.diff, /\+.*TeachManagedCompositions/)
    // dry_run 不落盘
    assert.equal(fs.existsSync(path.join(project.root, 'src', 'videos', '_teach-managed')), false)
  } finally {
    project.cleanup()
  }
})
