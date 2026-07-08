/**
 * AIDE - 结果输出格式化
 */

import chalk from 'chalk'
import type { ScanResult, Issue, Severity, Confidence } from '../types/index.js'

const SEVERITY_LABEL: Record<Severity, { icon: string; color: (s: string) => string }> = {
  critical: { icon: '🔴', color: chalk.red.bold },
  high: { icon: '🔴', color: chalk.red },
  medium: { icon: '🟡', color: chalk.yellow },
  low: { icon: '🟢', color: chalk.green },
  info: { icon: 'ℹ️', color: chalk.blue },
}

function issueConfidence(issue: Issue): Confidence {
  return issue.confidence || 'medium'
}

/** 默认格式：简洁文本列表（面向非专业用户） */
export function formatDefault(result: ScanResult): string {
  if (result.issues.length === 0) {
    return chalk.green.bold('✅ 未发现问题')
  }

  const lines: string[] = []
  lines.push(chalk.bold(`AIDE 发现 ${result.issues.length} 个问题：`))
  lines.push('')

  for (const issue of result.issues) {
    const label = SEVERITY_LABEL[issue.severity]
    const severityStr = label.color(`${issue.severity.toUpperCase()}`)
    const location = `${issue.file}:${issue.line}`
    lines.push(`${location}  [${severityStr}]  ${issue.message}`)
  }

  lines.push('')
  const { critical = 0, high = 0, medium = 0, low = 0, info: infoCount = 0 } = result.stats.bySeverity
  lines.push(`问题统计: 🔴 ${critical + high}  🟡 ${medium}  🟢 ${low}  ℹ️ ${infoCount}`)

  // LLM 复核统计
  if (result.stats.llmReview) {
    const lr = result.stats.llmReview
    lines.push(`LLM 复核: ${lr.reviewed} issues, 移除 ${lr.removed} 误报, ${lr.enhanced} 增强, 误报率 ${lr.reductionRate}%`)
  }

  return lines.join('\n')
}

/** 详细格式：带代码上下文和修复建议 */
export function formatVerbose(result: ScanResult): string {
  if (result.issues.length === 0) {
    return chalk.green.bold('✅ 未发现问题')
  }

  const lines: string[] = []
  lines.push(chalk.bold(`AIDE 发现 ${result.issues.length} 个问题：`))
  lines.push('')

  for (const issue of result.issues) {
    const label = SEVERITY_LABEL[issue.severity]
    const confidence = issueConfidence(issue)
    const llmTag = issue.llmMeta ? ` [LLM:${issue.llmMeta.verdict}]` : ''
    const header = label.color(`${issue.file}:${issue.line} [${issue.severity.toUpperCase()}] [CONF:${confidence.toUpperCase()}]${llmTag}`)
    lines.push(`${header} ${issue.message}`)

    // 代码上下文
    if (issue.snippet) {
      const lineNum = String(issue.line).padStart(4, ' ')
      lines.push(`   ${chalk.gray(lineNum + ' |')} ${issue.snippet}`)
    }

    // 修复建议
    if (issue.suggestion) {
      lines.push(`   ${chalk.cyan('修复建议：')}${issue.suggestion}`)
    }

    // LLM 判定理由
    if (issue.llmMeta) {
      const verdictColors: Record<string, (s: string) => string> = {
        verified: chalk.green,
        false_positive: chalk.red,
        enhanced: chalk.cyan,
      }
      const colorFn = verdictColors[issue.llmMeta.verdict] || chalk.gray
      lines.push(`   ${colorFn(`LLM判定: ${issue.llmMeta.reason}`)}`)
    }

    // 跨文件关联
    if (issue.related) {
      lines.push(`   ${chalk.gray('关联：')}${issue.related.file}:${issue.related.line} ${issue.related.message}`)
    }

    lines.push('')
  }

  const { critical = 0, high = 0, medium = 0, low = 0, info: infoCount = 0 } = result.stats.bySeverity
  lines.push(`问题统计: 🔴 ${critical + high}  🟡 ${medium}  🟢 ${low}  ℹ️ ${infoCount}`)

  if (result.stats.llmReview) {
    const lr = result.stats.llmReview
    lines.push(`LLM 复核: ${lr.reviewed} issues, 移除 ${lr.removed} 误报, ${lr.enhanced} 增强, 误报率 ${lr.reductionRate}%`)
  }

  return lines.join('\n')
}

/** AI 格式：可直接复制给 AI 修复 */
export function formatAI(result: ScanResult, lang: 'zh-CN' | 'en' = 'zh-CN'): string {
  if (result.issues.length === 0) {
    return lang === 'zh-CN' ? '✅ 未发现问题' : '✅ No issues found'
  }

  const lines: string[] = []

  if (lang === 'zh-CN') {
    lines.push('AIDE 检测到以下问题，请逐一修复：')
    lines.push('')

    const mustFix = result.issues.filter(i => i.severity === 'critical' || i.severity === 'high')
    const shouldFix = result.issues.filter(i => i.severity === 'medium')
    const niceToFix = result.issues.filter(i => i.severity === 'low' || i.severity === 'info')

    if (mustFix.length > 0) {
      lines.push('【必须修复】')
      for (const issue of mustFix) {
        lines.push(`- ${issue.file}:${issue.line}：${issue.message}`)
        if (issue.snippet) {
          lines.push(`  代码：${issue.snippet}`)
        }
        if (issue.suggestion) {
          lines.push(`  修复建议：${issue.suggestion}`)
        }
      }
      lines.push('')
    }

    if (shouldFix.length > 0) {
      lines.push('【建议修复】')
      for (const issue of shouldFix) {
        lines.push(`- ${issue.file}:${issue.line}：${issue.message}`)
        if (issue.snippet) {
          lines.push(`  代码：${issue.snippet}`)
        }
        if (issue.suggestion) {
          lines.push(`  修复建议：${issue.suggestion}`)
        }
      }
      lines.push('')
    }

    if (niceToFix.length > 0) {
      lines.push('【可选优化】')
      for (const issue of niceToFix) {
        lines.push(`- ${issue.file}:${issue.line}：${issue.message}`)
        if (issue.snippet) {
          lines.push(`  代码：${issue.snippet}`)
        }
      }
      lines.push('')
    }

    lines.push('修复完成后请让我重新检查。')
  } else {
    lines.push('AIDE detected the following issues. Please fix them one by one:')
    lines.push('')

    const mustFix = result.issues.filter(i => i.severity === 'critical' || i.severity === 'high')
    const shouldFix = result.issues.filter(i => i.severity === 'medium')

    if (mustFix.length > 0) {
      lines.push('MUST FIX:')
      for (const issue of mustFix) {
        lines.push(`- ${issue.file}:${issue.line}: ${issue.message}`)
        if (issue.snippet) {
          lines.push(`  Code: ${issue.snippet}`)
        }
        if (issue.suggestion) {
          lines.push(`  Fix: ${issue.suggestion}`)
        }
      }
      lines.push('')
    }

    if (shouldFix.length > 0) {
      lines.push('SHOULD FIX:')
      for (const issue of shouldFix) {
        lines.push(`- ${issue.file}:${issue.line}: ${issue.message}`)
        if (issue.snippet) {
          lines.push(`  Code: ${issue.snippet}`)
        }
        if (issue.suggestion) {
          lines.push(`  Fix: ${issue.suggestion}`)
        }
      }
      lines.push('')
    }

    lines.push('After fixing, please let me re-check.')
  }

  return lines.join('\n')
}

/** JSON 格式 */
export function formatJSON(result: ScanResult): string {
  return JSON.stringify(result, null, 2)
}

/**
 * 监工格式：专为非程序员设计
 * 按文件分组，只保留人话，去掉技术术语
 * 输出可直接复制给 AI 编程工具修复
 */
export function formatSupervisor(result: ScanResult, lang: 'zh-CN' | 'en' = 'zh-CN'): string {
  if (result.issues.length === 0) {
    return lang === 'zh-CN' ? '✅ 未发现问题，代码质量良好！' : '✅ No issues found, code looks good!'
  }

  const lines: string[] = []

  if (lang === 'zh-CN') {
    lines.push(`🔍 AIDE 发现 ${result.issues.length} 个问题：`)
    lines.push('')

    // 按文件分组
    const byFile = new Map<string, Issue[]>()
    for (const issue of result.issues) {
      const list = byFile.get(issue.file) || []
      list.push(issue)
      byFile.set(issue.file, list)
    }

    for (const [file, fileIssues] of byFile) {
      lines.push(`📁 ${file}`)
      for (const issue of fileIssues) {
        const severityIcon = issue.severity === 'critical' || issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : 'ℹ️'
        lines.push(`  ${severityIcon} 第 ${issue.line} 行：${issue.message}`)
        if (issue.snippet) {
          lines.push(`    └ 代码：${issue.snippet}`)
        }
        if (issue.suggestion) {
          lines.push(`    └ 建议：${issue.suggestion}`)
        }
        if (issue.llmMeta && issue.llmMeta.verdict === 'enhanced') {
          lines.push(`    └ LLM 判定：${issue.llmMeta.reason}`)
        }
      }
      lines.push('')
    }

    // 汇总
    const { critical = 0, high = 0, medium = 0 } = result.stats.bySeverity
    lines.push('─── 汇总 ───')
    if (result.stats.llmReview) {
      const lr = result.stats.llmReview
      lines.push(`LLM 已过滤 ${lr.removed} 个误报，最终发现 ${result.issues.length} 个真实问题`)
    }
    lines.push(`需要修复：🔴 ${critical + high} 个严重问题，🟡 ${medium} 个建议修复`)
    lines.push('')
    lines.push('💡 请将以上问题复制给 AI 编程助手进行修复。')
  } else {
    lines.push(`🔍 AIDE found ${result.issues.length} issues:`)
    lines.push('')

    const byFile = new Map<string, Issue[]>()
    for (const issue of result.issues) {
      const list = byFile.get(issue.file) || []
      list.push(issue)
      byFile.set(issue.file, list)
    }

    for (const [file, fileIssues] of byFile) {
      lines.push(`📁 ${file}`)
      for (const issue of fileIssues) {
        const severityIcon = issue.severity === 'critical' || issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : 'ℹ️'
        lines.push(`  ${severityIcon} Line ${issue.line}: ${issue.message}`)
        if (issue.snippet) {
          lines.push(`    └ Code: ${issue.snippet}`)
        }
        if (issue.suggestion) {
          lines.push(`    └ Fix: ${issue.suggestion}`)
        }
      }
      lines.push('')
    }

    const { critical = 0, high = 0, medium = 0 } = result.stats.bySeverity
    lines.push('─── Summary ───')
    if (result.stats.llmReview) {
      const lr = result.stats.llmReview
      lines.push(`LLM filtered ${lr.removed} false positives, found ${lr.reviewed - lr.removed} real issues`)
    }
    lines.push(`Must fix: 🔴 ${critical + high}, Should fix: 🟡 ${medium}`)
    lines.push('')
    lines.push('💡 Copy these issues to your AI coding assistant for repair.')
  }

  return lines.join('\n')
}

/** 格式化输出 */
export function formatReport(result: ScanResult, format: 'default' | 'verbose' | 'ai' | 'json' | 'supervisor' = 'default', lang: 'zh-CN' | 'en' = 'zh-CN'): string {
  switch (format) {
    case 'verbose': return formatVerbose(result)
    case 'ai': return formatAI(result, lang)
    case 'json': return formatJSON(result)
    case 'supervisor': return formatSupervisor(result, lang)
    default: return formatDefault(result)
  }
}
