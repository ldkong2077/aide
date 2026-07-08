/**
 * AIDE - 死代码检测器
 * 检测项目中可能未使用的公共 API 符号。
 *
 * 工作原理：
 * - 使用代码图（code-graph）的跨文件引用计数
 * - 对 refCount === 0 的导出符号报告
 * - 仅在有代码图时工作（--experimental crossfile）
 *
 * 与 unused-declaration 的区别：
 * - unused-declaration 检测单文件内的未使用声明（导入/变量）
 * - dead-code 检测跨文件未使用的公共 API（导出函数/类）
 *
 * 严重程度为 LOW，因为：
 * - 可能有动态引用（反射、getattr、字符串调用）
 * - 可能是为未来预留的 API
 */

import { isTestFile } from '../types/index.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'

export class DeadCodeDetector implements Detector {
  rule = 'dead-code'
  category = 'quality' as const
  description = '检测可能未使用的公共 API 符号（导出但无跨文件引用）'
  severity = 'low' as const

  detect(ctx: DetectorContext): Issue[] {
    const { filePath, codeGraph } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    // 需要代码图才能工作
    if (!codeGraph) return []

    const issues: Issue[] = []

    // 遍历代码图中当前文件的符号定义
    for (const [, defs] of codeGraph.symbols) {
      for (const def of defs) {
        // 只处理当前文件
        if (def.file !== filePath) continue

        // 只处理导出的符号（非导出符号由 unused-declaration 处理）
        if (!def.exported) continue

        // 跳过 Python __init__ / __new__ / dunder 方法
        if (def.name.startsWith('__') && def.name.endsWith('__')) continue

        // 检查引用计数：等于 0 表示无跨文件引用
        if (def.refCount === 0) {
          issues.push({
            rule: this.rule,
            severity: 'low',
            category: 'quality',
            file: filePath,
            line: def.line,
            message: `可能未使用的公共 API: "${def.name}"`,
            snippet: def.name,
            suggestion: `符号 "${def.name}" 被导出但未被其他文件引用。如确实不需要，建议删除或标记为私有（_ 前缀）。如为预留 API，可忽略此警告。`,
          })
        }
      }
    }

    return issues
  }
}
