#!/usr/bin/env node
/**
 * 版本与 git 联动。
 *
 * 单一版本源是 package.json；发布动作只做三件事：
 *   1. 改 package.json 的 version；
 *   2. 把 CHANGELOG 的 Unreleased 段落转成该版本；
 *   3. 提交并创建 annotated tag v<version>。
 *
 * 命令：
 *   node scripts/version.mjs show
 *   node scripts/version.mjs verify [--release|--source]
 *   node scripts/version.mjs bump <version> --notes "..." [--tag]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(ROOT, 'package.json');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');

function fail(message) {
  console.error('✗ ' + message);
  process.exit(1);
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    fail('git ' + args.join(' ') + ' 失败：' + (error.stderr || error.message));
  }
}

function readPackage() {
  return JSON.parse(readFileSync(PKG_PATH, 'utf8'));
}

function writePackage(pkg) {
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

function parseSemver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) throw new Error('不是合法 semver：' + value);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) return Number(a) < Number(b) ? -1 : 1;
    if (aNumber) return -1;
    if (bNumber) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left, right) {
  return compareSemver(parseSemver(left), parseSemver(right));
}

function isClean() {
  return git(['status', '--porcelain']) === '';
}

function exactTag() {
  return git(['describe', '--tags', '--exact-match', 'HEAD'], { allowFailure: true });
}

function latestTag() {
  return git(['describe', '--tags', '--always', '--dirty'], { allowFailure: true });
}

function changelogTopVersion() {
  // Keep a Changelog 的顶部是 [Unreleased]，版本校验取第一个已发布段落。
  const text = readFileSync(CHANGELOG_PATH, 'utf8');
  const versions = [...text.matchAll(/^## \[([^\]]+)\]/gm)]
    .map((match) => match[1])
    .filter((version) => version !== 'Unreleased');
  return versions[0];
}

function show() {
  const pkg = readPackage();
  console.log('package : ' + pkg.name + '@' + pkg.version);
  console.log('git     : ' + (latestTag() || '(no tag)') + ' / ' + git(['rev-parse', '--short', 'HEAD']));
  console.log('clean   : ' + (isClean() ? 'yes' : 'no'));
  console.log('tag@HEAD: ' + (exactTag() || '(none)'));
}

function verify({ release = false, source = false } = {}) {
  if (release && source) fail("--source 与 --release 不能同时使用");
  const pkg = readPackage();
  parseSemver(pkg.version);
  const top = changelogTopVersion();
  if (top !== pkg.version) {
    fail('CHANGELOG 顶部版本 ' + top + ' 与 package.json ' + pkg.version + ' 不一致（发布前先跑 bump）');
  }
  if (!pkg.engines || !pkg.engines.dsh) fail('package.json 缺少 engines.dsh');
  if (!pkg.scripts || pkg.scripts.verify !== 'node scripts/verify.mjs') {
    fail('package.json scripts.verify 未指向 scripts/verify.mjs');
  }
  if (source) {
    console.log('✓ 源码版本 ' + pkg.version + '，CHANGELOG 与 package 一致（未检查 Git/tag）');
    return;
  }
  const tag = exactTag();
  const allowedTags = ['v' + pkg.version, pkg.version + '-public'];
  if (tag && !allowedTags.includes(tag)) {
    fail('HEAD 的 tag ' + tag + ' 与 package 版本 ' + pkg.version + ' 不一致（允许 ' + allowedTags.join(' 或 ') + '）');
  }
  if (release) {
    if (!isClean()) fail('发布校验要求干净工作区');
    if (!tag) fail('发布校验要求 HEAD 位于 ' + allowedTags.join(' 或 ') + ' tag 上');
  } else if (!tag) {
    console.log('! HEAD 没有 tag；发布标签为 ' + allowedTags.join(' 或 '));
  }
  console.log('✓ 版本 ' + pkg.version + (tag ? '（' + tag + '）' : '（未打 tag）') + '，CHANGELOG 与 package 一致');
}

function renderVersionSection(version, notes) {
  const body = notes
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith('- ') ? line : '- ' + line))
    .join('\n');
  const date = new Date().toISOString().slice(0, 10);
  return '## [' + version + '] - ' + date + '\n\n' + body + '\n';
}

function updateChangelog(version, notes) {
  let text = readFileSync(CHANGELOG_PATH, 'utf8');
  const marker = '## [Unreleased]';
  const index = text.indexOf(marker);
  const rendered = renderVersionSection(version, notes);
  if (index === -1) {
    const firstSection = text.indexOf('\n## [');
    if (firstSection === -1) {
      text = text.trimEnd() + '\n\n' + rendered + '\n';
    } else {
      text = text.slice(0, firstSection) + '\n' + rendered + '\n' + text.slice(firstSection + 1);
    }
    writeFileSync(CHANGELOG_PATH, text);
    return;
  }
  const afterMarker = text.indexOf('\n## [', index + marker.length);
  const head = text.slice(0, index + marker.length);
  const remainder = afterMarker === -1 ? '' : text.slice(afterMarker + 1);
  const existing = afterMarker === -1
    ? text.slice(index + marker.length)
    : text.slice(index + marker.length, afterMarker);
  const inherited = existing.trim();
  const section = renderVersionSection(version, notes + (inherited ? '\n' + inherited : ''));
  writeFileSync(CHANGELOG_PATH, head + '\n\n' + section + (remainder ? '\n' + remainder : ''));
}

function parseArgs(argv) {
  const args = { positionals: [], notes: '', tag: false, release: false, source: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tag') args.tag = true;
    else if (arg === '--release') args.release = true;
    else if (arg === '--source') args.source = true;
    else if (arg === '--notes') {
      args.notes = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--notes=')) args.notes = arg.slice('--notes='.length);
    else args.positionals.push(arg);
  }
  return args;
}

function bump(args) {
  const version = args.positionals[0];
  if (!version) fail('用法：bump <version> --notes "..." [--tag]');
  parseSemver(version);
  if (!args.notes.trim()) fail('bump 需要 --notes，避免空发布说明');
  if (!isClean()) fail('bump 要求干净工作区（先提交）');
  const pkg = readPackage();
  if (compareVersions(version, pkg.version) <= 0) {
    fail('新版本 ' + version + ' 必须大于当前 ' + pkg.version);
  }
  if (git(['tag', '-l', 'v' + version]) !== '') fail('tag v' + version + ' 已存在');

  pkg.version = version;
  writePackage(pkg);
  updateChangelog(version, args.notes);

  git(['add', 'package.json', 'CHANGELOG.md']);
  git(['commit', '-m', 'chore(release): v' + version, '-m', args.notes.trim()]);
  if (args.tag) {
    git(['tag', '-a', 'v' + version, '-m', 'v' + version + '\n\n' + args.notes.trim()]);
  }
  console.log('✓ 已提交 ' + version + (args.tag ? ' 并创建 tag v' + version : '（未打 tag）'));
}

function main([command, ...rest]) {
  const args = parseArgs(rest);
  switch (command) {
    case 'show': return show();
    case 'verify': return verify({ release: args.release, source: args.source });
    case 'bump': return bump(args);
    case undefined:
    case '--help':
    case '-h':
      return console.log('用法：node scripts/version.mjs show|verify [--release|--source]|bump <version> --notes "..." [--tag]');
    default: return fail('未知命令：' + command);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { fail(error.message); }
}
