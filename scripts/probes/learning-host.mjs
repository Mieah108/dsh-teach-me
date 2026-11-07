#!/usr/bin/env node
/* 使用实际安装的宿主数据域 + JSON 后端，在临时目录验证保存、重开和会话隔离。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createTeachingPreferences } from '../../lib/teaching-preferences.js'
const host = process.env.TEACH_HOST_ROOT ?? path.resolve(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh')
const modules = path.join(host, 'node_modules/@deepseek-ai')
const { DomainFacility } = await import(pathToFileURL(path.join(modules, 'dsh-storage-domain/lib/index.js')))
const { JsonStorageBackend } = await import(pathToFileURL(path.join(modules, 'dsh-storage-json/lib/index.js')))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-host-domain-'))
let backend
let facility
const open = () => {
  backend = new JsonStorageBackend(root)
  facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {} } }, { backend: 'json' })
  return createTeachingPreferences(() => facility, () => ({ teaching: { factCheck: 'strict', depth: 'deep' } }))
}
try {
  let service = open()
  assert.equal((await service.ensure('session-a')).factCheck, 'strict')
  await service.update('session-a', { factCheck: 'none', collectionId: 'second' }, '/workspace')
  assert.equal((await service.ensure('session-b')).factCheck, 'strict')
  await service.close(); await facility.closeAll(); await backend.close()
  service = open()
  const restored = await service.ensure('session-a')
  assert.equal(restored.factCheck, 'none')
  assert.equal(restored.collections['/workspace'], 'second')
  await assert.rejects(service.update('session-a', { depth: 'invalid' }, '/workspace'))
  assert.equal((await service.ensure('session-a')).depth, 'deep')
  await service.close(); await facility.closeAll(); await backend.close()
  const slotFile = fs.readFileSync(path.join(modules, 'dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts'), 'utf8')
  assert.match(slotFile, /'conversation.input.dock'/)
  const bundleDir = path.join(modules, 'dsh-web-frontend/dist/assets')
  const bundle = fs.readdirSync(bundleDir).filter((name) => name.startsWith('index-') && name.endsWith('.js')).map((name) => fs.readFileSync(path.join(bundleDir, name), 'utf8')).find((text) => text.includes('DisclosureRow:'))
  assert.ok(bundle?.includes('DisclosureRow:'))
  console.log(JSON.stringify({ hostVersion: JSON.parse(fs.readFileSync(path.join(host, 'package.json'))).version, storage: 'actual DomainFacility + JsonStorageBackend: save/reopen/isolation/validation passed', inputDock: true, disclosureRowExport: true }, null, 2))
} finally { await backend?.close(); fs.rmSync(root, { recursive: true, force: true }) }
