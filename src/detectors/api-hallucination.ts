/**
 * AIDE - API 幻觉检测器
 * 检测 AI 生成代码中常见的不存在 API 调用
 *
 * 从 hallucination-apis.ts 数据按语言匹配规则
 */

import { isTestFile } from '../types/index.js'
import { getLineNumber, isInNonCode } from '../core/utils.js'
import type { Detector, DetectorContext, Issue, Language, Severity } from '../types/index.js'
import { getHallucinationAPIsByLanguage, type HallucinatedAPI } from '../data/hallucination-apis.js'

interface CompiledHallucinationAPI {
  rule: HallucinatedAPI
  regex: RegExp
}

export class ApiHallucinationDetector implements Detector {
  rule = 'api-hallucination'
  category = 'hallucination' as const
  description = '检测 AI 生成代码中常见的不存在 API 调用'
  severity = 'high' as const

  /** 每条规则最多匹配次数 */
  private static readonly MAX_MATCHES_PER_RULE = 100

  private static readonly compiledRules = new Map<Language, CompiledHallucinationAPI[]>()
  /** 需要类型上下文检查的规则 */
  private static readonly CONTEXT_CHECK_RULES = new Set(['\\.merge\\(', '\\.flatten\\(\\)', '\\.groupBy\\('])

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    const rules = ApiHallucinationDetector.getCompiledRules(language)
    if (rules.length === 0) return []

    const issues: Issue[] = []

    for (const { rule, regex } of rules) {
      regex.lastIndex = 0
      let match: RegExpExecArray | null
      let matchCount = 0

      while ((match = regex.exec(source)) !== null) {
        // 防止零宽匹配导致无限循环
        if (match[0].length === 0) {
          regex.lastIndex++
          continue
        }

        matchCount++
        if (matchCount > ApiHallucinationDetector.MAX_MATCHES_PER_RULE) break

        // 跳过字符串/注释/正则中的匹配
        if (isInNonCode(source, match.index!)) continue

        // 对 .merge() 和 .flatten() 进行类型上下文检查
        if (ApiHallucinationDetector.CONTEXT_CHECK_RULES.has(rule.pattern)) {
          if (this.shouldSkipByContext(source, match.index, rule.pattern)) continue
        }

        const line = getLineNumber(source, match.index!)
        const lineText = source.split('\n')[line - 1] || ''

        issues.push({
          rule: this.rule,
          severity: rule.severity as Severity,
          confidence: 'high',
          category: 'hallucination',
          file: filePath,
          line,
          message: rule.message,
          snippet: lineText.trim(),
          suggestion: rule.suggestion,
        })
      }
    }

    return issues
  }

  /**
   * 检查是否应该基于上下文跳过检测
   * 对于 .merge()/.flatten()，如果前面有 DataFrame/numpy 相关变量，则跳过
   * 对于 .groupBy()，如果前面有 Prisma/Sequelize/Lodash 等 ORM/库调用，则跳过
   */
  private shouldSkipByContext(source: string, matchIndex: number, pattern: string): boolean {
    const before = source.substring(Math.max(0, matchIndex - 300), matchIndex)

    // 检查是否导入了 pandas/numpy
    const hasPandasImport = /\bimport\s+(?:pandas|pd)\b/.test(before) || /\bfrom\s+(?:pandas|pd)\b/.test(before)
    const hasNumpyImport = /\bimport\s+(?:numpy|np)\b/.test(before) || /\bfrom\s+(?:numpy|np)\b/.test(before)

    if (pattern === '\\.merge\\(') {
      // 如果导入了 pandas，检查前面是否有 DataFrame 相关变量名
      if (hasPandasImport) {
        // DataFrame 常见变量名
        if (/\b(?:df|dataframe|table|dataset|spreadsheet|result|merged|joined)\b/i.test(before)) return true
      }
      // 如果导入了 numpy，.merge() 不是 numpy 的方法，保持检测
    }

    if (pattern === '\\.flatten\\(\\)') {
      // 如果导入了 numpy，检查前面是否有 ndarray 相关变量名
      if (hasNumpyImport) {
        // ndarray 常见变量名
        if (/\b(?:arr|array|ndarray|matrix|tensor|data|result|flattened)\b/i.test(before)) return true
      }
      // 如果导入了 pandas，DataFrame 没有 flatten() 方法，保持检测
    }

    if (pattern === '\\.groupBy\\(') {
      // Prisma/Sequelize/TypeORM/Mongoose/Lodash 等 ORM/库都有 groupBy 方法
      // 检查整个源码中是否有这些库的导入或调用模式（不只是匹配位置前 300 字符）
      const fullSource = source
      const hasOrmContext = /\bprisma\.\w+\.\w+\(/.test(fullSource)
        || /\b(?:sequelize|Sequelize)\b/.test(fullSource)
        || /\b(?:Model|QueryInterface)\.\w+\(/.test(fullSource)
        || /import.*(?:prisma|sequelize|typeorm|mongoose)/.test(fullSource)
        || /require.*(?:prisma|sequelize|typeorm|mongoose)/.test(fullSource)
        || /\b_(?:groupBy|chain|keyBy)\(/.test(fullSource)  // Lodash
        || /\blodash\b/.test(fullSource)
      if (hasOrmContext) return true
    }

    return false
  }

  private static getCompiledRules(language: Language): CompiledHallucinationAPI[] {
    const cached = this.compiledRules.get(language)
    if (cached) return cached

    const compiled = getHallucinationAPIsByLanguage(language).map(rule => ({
      rule,
      regex: new RegExp(rule.pattern, 'g'),
    }))
    this.compiledRules.set(language, compiled)
    return compiled
  }
}
