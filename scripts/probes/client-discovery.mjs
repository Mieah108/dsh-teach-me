#!/usr/bin/env node
/* P0 探针：全局设置行是否能在真实 dsh-client-modules 实现里被发现。
 *
 * 这不是模拟：直接调用宿主已安装的 ClientModuleRegistry.prototype.locatePkgJson，
 * 用真实的 profile cordis.yml 作为 baseUrl，分别验证：
 *   1. 精确包根（新写法）→ 能找到包，客户端半边可加载；
 *   2. 子路径 /settings（旧写法）→ 找不到（S1 的负向对照）。
 *
 * 证据写到 artifacts/probes/client-discovery.json。
 * 跑法：node scripts/probes/client-discovery.mjs [--profile <cordis.yml 路径>]
 */

import { execFileSync } from 'node:child_process'
import { realpathSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputIndex = process.argv.indexOf('--output')
const outFile = resolve(outputIndex === -1 ? join(ROOT, 'artifacts/probes/client-discovery.json') : process.argv[outputIndex + 1])

function hostDshRoot() {
  if (process.env.DSH_HOST_ROOT) return process.env.DSH_HOST_ROOT
  const bin = realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
  // <...>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/...
  return join(dirname(dirname(bin)), 'node_modules')
}

function profileArgument() {
  const index = process.argv.indexOf('--profile')
  if (index !== -1 && process.argv[index + 1]) return resolve(process.argv[index + 1])
  return join(process.env.HOME ?? '', '.dsh/profiles/web/cordis.yml')
}

const nodeModules = hostDshRoot()
const clientModulesEntry = join(nodeModules, '@deepseek-ai/dsh-client-modules/lib/index.js')
const { ClientModuleRegistry } = await import(pathToFileURL(clientModulesEntry).href)

const profile = profileArgument()
const base = pathToFileURL(profile).href
const registry = { ctx: { loader: {} }, nearestPackage: ClientModuleRegistry.prototype.nearestPackage }
const locate = (specifier) =>
  ClientModuleRegistry.prototype.locatePkgJson.call(registry, specifier, base)

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const exact = locate(pkg.name)
const legacy = locate(pkg.name + '/settings')

const evidence = {
  checkedAt: new Date().toISOString(),
  profile,
  hostModules: nodeModules,
  rows: {
    exactPackageRoot: { specifier: pkg.name, discovered: exact !== undefined, packageJson: exact ?? null },
    legacySettingsSubpath: { specifier: pkg.name + '/settings', discovered: legacy !== undefined }
  },
  expected: { exactPackageRoot: true, legacySettingsSubpath: false }
}
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))

const ok = evidence.rows.exactPackageRoot.discovered === true && evidence.rows.legacySettingsSubpath.discovered === false
if (!ok) {
  console.error('✗ 客户端发现探针不符合预期')
  process.exit(1)
}
console.log('✓ 精确包根可被发现，旧 /settings 子路径如预期失败')
