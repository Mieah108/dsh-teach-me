/* 随包技能：把 skills/<name>/SKILL.md 注册进「教学模式」这一层。
   预设层注册是平台原生能力（skills 服务按调用上下文的 scope 分层），
   所以这两个技能只对教学模式可见，不会污染其它会话。
   正文与资源都留在包内，resourceBase 指向目录，模型按需读子文件。 */

import path from 'node:path'
import { isFile, listDirs, parseFrontmatter, readIfExists, readJsonIfExists } from './util.js'

/**
 * 读一个技能目录，组装 SkillRegistration。
 * @param {string} dir 技能目录（含 SKILL.md）
 * @param {string} fallbackName 没有 frontmatter name 时用的名字
 * @param {{modelInvocable: boolean, userInvocable: boolean}} invocation
 */
function skillFromDir(dir, fallbackName, invocation) {
  const file = path.join(dir, 'SKILL.md')
  if (!isFile(file)) return undefined
  const text = readIfExists(file)
  if (text === undefined) return undefined
  const { data, body } = parseFrontmatter(text)
  const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : fallbackName
  const description = typeof data.description === 'string' ? data.description : fallbackName
  const whenToUse = typeof data.when_to_use === 'string' ? data.when_to_use : typeof data['when-to-use'] === 'string' ? data['when-to-use'] : undefined
  return {
    registration: {
      name,
      description,
      ...(whenToUse !== undefined ? { whenToUse } : {}),
      source: 'bundled',
      invocation,
      resourceBase: { kind: 'directory', path: dir },
      path: file,
      content: body,
      metadata: {
        // 上游头部若写了 disable-model-invocation，这里如实保留供排查
        upstreamDisableModelInvocation: data['disable-model-invocation'] === true || data['disable-model-invocation'] === 'true',
        ...(typeof data.version === 'string' ? { version: data.version } : {})
      }
    },
    file
  }
}

/**
 * 注册 <pkgRoot>/skills 下的全部技能；返回注册摘要（给插件自己用，也可写进交付报告）。
 * 注册表缺失时静默跳过：插件保持可用，只是没有内置技能。
 */
export function registerSkills(ctx, config, packageRoot) {
  const skillsService = typeof ctx.get === 'function' ? ctx.get('skills') : ctx.skills
  if (skillsService === undefined || skillsService === null) return { registered: [], skipped: ['skills service 不可用'] }

  const root = config.skills.dir.length > 0 ? path.resolve(config.skills.dir) : path.join(packageRoot, 'skills')
  const invocation = {
    modelInvocable: config.skills.modelInvocable,
    userInvocable: config.skills.userInvocable
  }
  const upstreamFile = readJsonIfExists(path.join(root, 'UPSTREAM.json'))
  const upstream = upstreamFile !== null && typeof upstreamFile === 'object' && typeof upstreamFile.skills === 'object' ? upstreamFile.skills : undefined
  const registered = []
  const skipped = []

  for (const dirName of listDirs(root)) {
    const dir = path.join(root, dirName)
    const entry = skillFromDir(dir, dirName, invocation)
    if (entry === undefined) {
      skipped.push(`${dirName}（没有 SKILL.md）`)
      continue
    }
    try {
      ctx.effect(() => skillsService.register(entry.registration), `teach-me.skill(${entry.registration.name})`)
      registered.push({
        name: entry.registration.name,
        path: dir,
        modelInvocable: invocation.modelInvocable,
        upstream: upstream?.[entry.registration.name]
      })
    } catch (error) {
      skipped.push(`${dirName}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  return { registered, skipped }
}
