/**
 * AIDE - LLM 批处理器
 * 按文件分组 issues，控制批次大小和并发
 */

import type { IssueWithContext } from './llm-types.js'
import type { Issue } from '../types/index.js'

/** 批处理结果 */
export interface BatchResult {
  batches: IssueWithContext[][]
  totalIssues: number
  fileGroups: Map<string, IssueWithContext[]>
}

/** 批处理器配置 */
export interface BatcherConfig {
  /** 每批最大 issue 数（默认 10） */
  batchSize: number
  /** 最大并发 LLM 调用数（默认 3） */
  maxConcurrency: number
}

/**
 * 按文件分组 issues，生成批处理列表。
 * 同文件的 issues 归为一组（上下文更好），按 severity 排序。
 */
export function batchIssues(
  issues: (IssueWithContext)[],
  config: BatcherConfig = { batchSize: 10, maxConcurrency: 3 },
): BatchResult {
  // 按文件分组
  const fileGroups = new Map<string, IssueWithContext[]>()
  for (const item of issues) {
    const group = fileGroups.get(item.issue.file) || []
    group.push(item)
    fileGroups.set(item.issue.file, group)
  }

  // 对每组按 severity 排序（critical > high > medium > low > info）
  const severityOrder: Record<string, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
  }
  for (const [, group] of fileGroups) {
    group.sort((a, b) => {
      const sa = severityOrder[a.issue.severity] ?? 99
      const sb = severityOrder[b.issue.severity] ?? 99
      if (sa !== sb) return sa - sb
      return a.issue.line - b.issue.line
    })
  }

  // 将分组拆分为批次
  const batches: IssueWithContext[][] = []
  for (const [, group] of fileGroups) {
    for (let i = 0; i < group.length; i += config.batchSize) {
      batches.push(group.slice(i, i + config.batchSize))
    }
  }

  return { batches, totalIssues: issues.length, fileGroups }
}

/**
 * 并发执行批处理任务，控制最大并发数。
 * 类似 Promise.all 但限制并发度。
 */
export async function runConcurrently<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  maxConcurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0

  const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++
      results[currentIndex] = await fn(items[currentIndex]!, currentIndex)
    }
  })

  await Promise.all(workers)
  return results
}

/** 按规则定制上下文行数（减少 token 消耗） */
const RULE_CONTEXT_LINES: Record<string, number> = {
  // 只需要 import 行，1 行上下文足够
  'package-hallucination': 1,
  // 只需要 API 调用行，2 行上下文足够
  'api-hallucination': 2,
  // 只需要函数签名+返回值，2 行上下文足够
  'stub-function': 2,
  'empty-impl': 2,
  // URL/路径只需本行
  'fake-url': 1,
  'hardcoded-value': 1,
}

/**
 * 从 Issue 中提取源码上下文。
 * 按 rule 定制上下文行数，未配置的规则按 severity 降级
 */
export function extractSourceContext(
  source: string,
  line: number,
  severity?: string,
  rule?: string,
): string {
  // 优先按规则定制，否则按严重程度降级
  let contextLines: number
  if (rule && RULE_CONTEXT_LINES[rule] !== undefined) {
    contextLines = RULE_CONTEXT_LINES[rule]!
  } else {
    switch (severity) {
      case 'critical':
      case 'high':
        contextLines = 5
        break
      case 'medium':
        contextLines = 3
        break
      default:
        contextLines = 2
    }
  }

  const lines = source.split('\n')
  const start = Math.max(0, line - 1 - contextLines)
  const end = Math.min(lines.length, line - 1 + contextLines + 1)
  const contextLinesArr: string[] = []

  for (let i = start; i < end; i++) {
    const prefix = i + 1 === line ? '>>> ' : '    '
    contextLinesArr.push(`${prefix}${i + 1}| ${lines[i]}`)
  }

  return contextLinesArr.join('\n')
}

/**
 * 生成跨文件引用信息的文本描述。
 */
export function formatCrossFileInfo(
  file: string,
  rule: string,
  issueMessage: string,
  projectSymbols?: { referencedAcrossFiles: Set<string> },
  codeGraph?: { symbols: Map<string, Array<{ refCount: number; references: Array<{ file: string; line: number }> }>> },
): string {
  const parts: string[] = []
  const issueName = extractIssueName(issueMessage)

  if (projectSymbols && projectSymbols.referencedAcrossFiles.has(issueName)) {
    parts.push(`跨文件引用: "${issueName}" 被其他文件引用`)
  }

  if (codeGraph?.symbols) {
    const symbolEntries = Array.from(codeGraph.symbols.entries())
    for (const [name, defs] of symbolEntries) {
      if (name === issueName) {
        for (const def of defs) {
          if (def.refCount > 0) {
            parts.push(`符号 "${name}" 有 ${def.refCount} 个跨文件引用`)
          }
        }
      }
    }
  }

  return parts.length > 0 ? parts.join('\n') : ''
}

/** 从 issue 消息中提取可能的标识符名称 */
function extractIssueName(message: string): string {
  // 尝试从消息中提取被引用的标识符名
  const patterns = [
    /函数\s+"([^"]+)"/,
    /函数\s+'([^']+)'/,
    /符号\s+"([^"]+)"/,
    /符号\s+'([^']+)'/,
    /未使用的声明:\s+"([^"]+)"/,
    /Stub\s+函数\s+"([^"]+)"/,
    /空实现函数\s+"([^"]+)"/,
    /可能不存在的[^:]+:\s+"([^"]+)"/,
    /硬编码的[^:]+:\s+"([^"]+)"/,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(message)
    if (match?.[1]) return match[1]
  }

  return ''
}
