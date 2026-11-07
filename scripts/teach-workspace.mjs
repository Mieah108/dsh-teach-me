#!/usr/bin/env node
/* 学习档案的离线维护命令：只做诊断与显式修复，不在教学会话里偷偷跑。
 *
 * 用法：
 *   node scripts/teach-workspace.mjs --workspace <目录> [--status] [--json]
 *   node scripts/teach-workspace.mjs --workspace <目录> --rebuild
 *   node scripts/teach-workspace.mjs --workspace <目录> --repair-tail
 *   node scripts/teach-workspace.mjs --workspace <目录> --migrate
 *
 * --repair-tail 只修「最后一行写了一半」，修复前把整个档案目录（.dsh-teach-me/archive）备份到 backups/。
 * 其它损坏（哈希不符、序号断裂）一律拒绝，先自己看日志，别让脚本猜。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { archiveStatusFor } from '../lib/archive/tools.js'
import { archiveStatus, rebuildArchive } from '../lib/archive/operations.js'
import { inspectJournal, repairPartialTail } from '../lib/archive/journal.js'
import { openArchive, resolveArchiveDir } from '../lib/archive/store.js'

const USAGE = `用法：node scripts/teach-workspace.mjs --workspace <目录> [选项]

选项：
  --status       只读状态（默认）
  --rebuild      用日志重建 index.json（不改日志）
  --repair-tail  只修最后一行写了一半的日志，修前整份备份
  --migrate      打开档案并按当前 schema 迁移（迁移前自动备份）
  --snapshot     全量重放后显式生成派生快照，不截断日志
  --snapshot-status  只读打开并报告快照使用情况（不修索引）
  --json         输出 JSON，便于脚本消费
`

function parseArgs(argv) {
  const options = { command: 'status', workspace: '', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--workspace') {
      options.workspace = argv[index + 1] ?? ''
      index += 1
    } else if (arg.startsWith('--workspace=')) {
      options.workspace = arg.slice('--workspace='.length)
    } else if (arg === '--status') options.command = 'status'
    else if (arg === '--rebuild') options.command = 'rebuild'
    else if (arg === '--repair-tail') options.command = 'repair-tail'
    else if (arg === '--migrate') options.command = 'migrate'
    else if (arg === '--snapshot') options.command = 'snapshot'
    else if (arg === '--snapshot-status') options.command = 'snapshot-status'
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.command = 'help'
    else if (arg.startsWith('-')) throw new Error('不认识的参数：' + arg)
    else if (options.workspace === '') options.workspace = arg
    else throw new Error('只能给一个工作区目录：' + arg)
  }
  return options
}

function resolveWorkspace(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('需要 --workspace <学习工作区目录>')
  const absolute = path.resolve(raw)
  let root
  try {
    root = fs.realpathSync.native(absolute)
  } catch {
    throw new Error('工作区不存在：' + absolute)
  }
  if (!fs.statSync(root).isDirectory()) throw new Error('工作区不是目录：' + root)
  return root
}

function print(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
    return
  }
  if (typeof value === 'string') {
    console.log(value)
    return
  }
  console.log(JSON.stringify(value, null, 2))
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help') {
    console.log(USAGE)
    return 0
  }
  const root = resolveWorkspace(options.workspace)
  // 与运行期同一条解析链：新布局优先，旧 .teach 会在第一次打开时整体搬进 .dsh-teach-me/archive。
  const archiveDir = resolveArchiveDir(root, { migrate: !['status', 'snapshot-status', 'snapshot'].includes(options.command) }).dir

  if (options.command === 'snapshot' || options.command === 'snapshot-status') {
    const archive = openArchive(root, { create: false, repairIndex: false })
    const result = options.command === 'snapshot' ? archive.createSnapshot() : { ...archive.replayInfo, summary: archive.summary(), warnings: archive.warnings }
    print({ workspace: root, ...result }, options.json)
    return 0
  }

  if (options.command === 'status') {
    const status = archiveStatusFor(root)
    if (options.json) {
      print(
        {
          workspace: root,
          archiveDir,
          initialized: status.initialized,
          summary: status.summary,
          dueReviews: status.dueReviews,
          warnings: status.warnings
        },
        true
      )
    } else {
      console.log('工作区：' + root)
      console.log(status.text)
      if (status.initialized) {
        console.log('')
        console.log('日志：' + JSON.stringify(inspectJournal(archiveDir)))
      }
    }
    return 0
  }

  if (options.command === 'rebuild') {
    const result = rebuildArchive(root)
    print(
      options.json
        ? { workspace: root, ...result }
        : `索引已从日志重建：revision ${result.revision}，seq ${result.lastSeq}，旧索引 revision ${String(result.previousIndexRevision)}`,
      options.json
    )
    return 0
  }

  if (options.command === 'repair-tail') {
    const before = inspectJournal(archiveDir)
    const result = repairPartialTail(archiveDir)
    print(
      options.json
        ? { workspace: root, before, ...result }
        : result.repaired
          ? `已修掉半行：${result.file}，删除 ${result.removedBytes} 字节；备份在 ${result.backup}`
          : `没有修：${result.reason}`,
      options.json
    )
    return 0
  }

  if (options.command === 'migrate') {
    const archive = openArchive(root, { create: false })
    const identityPath = path.join(archiveDir, 'workspace.json')
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'))
    const result = { workspace: root, workspaceId: archive.workspaceId, schemaVersion: identity.schemaVersion, migrated: identity.migratedFrom !== undefined, migrationBackup: identity.migrationBackup ?? null }
    print(options.json ? result : `档案已打开：schema ${result.schemaVersion}，workspace ${result.workspaceId}` + (result.migrated ? `；从 schema ${identity.migratedFrom} 迁移，备份在 ${result.migrationBackup}` : '；无需迁移'), options.json)
    return 0
  }

  throw new Error('未知命令：' + options.command)
}

try {
  process.exitCode = main()
} catch (error) {
  console.error('teach-workspace: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
}
