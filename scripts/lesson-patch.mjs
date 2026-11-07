#!/usr/bin/env node
/* G2 离线入口：默认演练；--apply 只更新源文件，之后再 teach_commit。 */
import fs from 'node:fs'
import { inspectSpecFile, patchSpecFile } from '../lib/lessonspec/patch.js'

try {
  const args = process.argv.slice(2)
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--apply') options.apply = true
    else if (flag === '--inspect') options.inspect = true
    else if (['--workspace', '--spec', '--patch'].includes(flag)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error('缺参数：' + flag)
      options[flag.slice(2)] = value
    } else if (flag === '--help' || flag === '-h') options.help = true
    else throw new Error('未知参数：' + flag)
  }
  if (options.help) console.log('node scripts/lesson-patch.mjs --workspace <目录> --spec <spec.json> [--inspect | --patch <patch.json> [--apply]]；默认演练')
  else {
    if (!options.workspace || !options.spec) throw new Error('需要 --workspace / --spec')
    if (options.inspect && (options.patch || options.apply)) throw new Error('--inspect 不能与 --patch/--apply 同用')
    if (options.inspect) console.log(JSON.stringify(inspectSpecFile(options.workspace, options.spec), null, 2))
    else {
      if (!options.patch) throw new Error('需要 --patch 或 --inspect')
      const patch = JSON.parse(fs.readFileSync(options.patch, 'utf8'))
      console.log(JSON.stringify(patchSpecFile(options.workspace, options.spec, patch, { dryRun: !options.apply }), null, 2))
    }
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.code ?? 'lesson-spec-patch-failed', message: error.message }))
  process.exitCode = 1
}
