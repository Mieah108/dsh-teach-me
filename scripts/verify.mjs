#!/usr/bin/env node
/**
 * 统一校验入口：版本 + 技能快照 + 单元测试 + selftest。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const quick = process.argv.includes('--quick');
const source = process.argv.includes('--source');
if (source && release) throw new Error('--source 与 --release 不能同时使用');

function run(label, command, args) {
  console.log('\n▶ ' + label);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('✗ ' + label + ' 失败（exit ' + result.status + '）');
    process.exit(result.status ?? 1);
  }
}

run('版本与 tag', process.execPath, ['scripts/version.mjs', 'verify', ...(release ? ['--release'] : []), ...(source ? ['--source'] : [])]);
run('技能快照', process.execPath, ['scripts/sync-skills.mjs', '--check'])
// 宿主 ptc 预设漂移：宿主未安装时本步自跳过（exit 0），不阻塞别人的机器。
if (!source) run('预设漂移', process.execPath, ['scripts/check-preset-drift.mjs']);
run('公开文件检查', process.execPath, ['scripts/check-release.mjs']);
if (!quick) {
  run('组件来源与静态构建产物', process.execPath, ['scripts/build-components.mjs', '--check']);
  run('单元测试', process.execPath, ['--test', 'test/**/*.test.js']);
  run('自测', process.execPath, ['scripts/selftest.mjs']);
}
console.log('\n✓ verify 通过');
