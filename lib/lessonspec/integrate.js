/* LessonSpec 与发布链的接缝（E2）：让 teach_commit 直接吃 spec JSON，把编译器接进既有流程。
 *
 * 设计取舍（为什么不做成新工具）：
 *   - 工具数是常驻成本，spec 编写是偶发动作；加一个工具等于让**每个会话**都为偶发路径付费。
 *   - 发布本来就要求"页面 + 题目"一次事务提交；spec 恰好同时声明了这两样，
 *     所以把编译放进 teach_commit 是唯一能保证"页面与题目同源"的位置。
 *   - 编译产物与 spec 一一对应（<name>.json → <name>.html），可重新生成、可 diff。
 */

import fs from 'node:fs'
import path from 'node:path'

import { lintHtml } from '../lint.js'
import { compileSpec } from './compile.js'
import { LessonSpecError, validateSpec } from './schema.js'

/** 只有 .json 才当 spec：其它扩展名仍走原来的 HTML 路线，行为不变。 */
export const isSpecPath = (value) => /\.json$/i.test(String(value ?? ''))

/**
 * spec → 同目录同名 .html（编译产物路径由 spec 决定，不由调用方指定）。
 * 约定名 *.spec.json 会去掉 .spec：lessons/0001.spec.json → lessons/0001.html，
 * 这样目录里"源文件 / 产物"一眼能对上；其它 *.json 只换扩展名。
 */
export const specHtmlPathOf = (specPath) => String(specPath).replace(/(\.spec)?\.json$/i, '.html')

/**
 * 读 + 校验 + 编译。任何不合法都抛 LessonSpecError（带 code=lesson-spec-invalid）。
 * @param {string} specPath spec 的绝对路径
 */
export function compileSpecAt(specPath) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(specPath, 'utf8'))
  } catch (error) {
    throw new LessonSpecError('读不了 spec（' + specPath + '）：' + (error instanceof Error ? error.message : String(error)), {
      cause: 'unreadable'
    })
  }
  const spec = validateSpec(raw)
  const { html } = compileSpec(raw)
  return { spec, html, htmlPath: specHtmlPathOf(specPath) }
}

/** 编译结果的硬伤（发布前必须为零：页面是交付面，硬伤等于交付残次品）。 */
export function specLintErrors(html, htmlPath) {
  return lintHtml(html, htmlPath).filter((issue) => issue.level === 'error')
}

/** spec 里声明的自测题 → 档案的题目参数（与 teach_question_register 同形，单一口径来源）。 */
export function questionsOfSpec(spec, lessonId) {
  const questions = []
  for (const section of spec.sections) {
    if (section.kind !== 'quiz') continue
    for (const question of section.questions) {
      const args = { questionId: question.questionId, lessonId, type: question.type, prompt: question.prompt }
      if (question.scope !== undefined) args.prerequisite = question.scope
      if (question.options !== undefined) args.options = question.options
      if (question.answer !== undefined) args.answer = question.answer
      if (question.rubric !== undefined) args.rubric = question.rubric
      questions.push(args)
    }
  }
  return questions
}

/** 把错误整理成发布回执能用的形状（code + 人读原因 + 可执行下一步）。 */
export function describeSpecError(error) {
  if (error instanceof LessonSpecError) {
    const detail = error.detail
    return {
      code: error.code ?? 'lesson-spec-invalid',
      message: error.message,
      detail,
      recoverable: true,
      nextAction: detail?.cause === 'unreadable' ? 'fix-input' : 'fix-input'
    }
  }
  return {
    code: 'lesson-spec-compile-failed',
    message: error instanceof Error ? error.message : String(error),
    recoverable: true,
    nextAction: 'fix-input'
  }
}
