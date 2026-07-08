/**
 * AIDE - 异常吞噬检测器
 * 检测 catch/except 块中吞没异常而不处理的模式
 */

import { isTestFile } from '../types/index.js'
import { extractBlockBody, getLineNumber, escapeRegex } from '../core/utils.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'
import type { ParseResult } from '../core/ast-parser.js'
import type { PythonASTResult } from '../core/python-ast-bridge.js'

export class SwallowedErrorDetector implements Detector {
  rule = 'swallowed-error'
  category = 'ai-code' as const
  description = '检测异常吞噬（catch/except 块为空或仅打印日志）'
  severity = 'high' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    // 当 AST 可用时，提取 try 块边界用于验证
    const tryBlockBoundaries: Array<{ startLine: number; endLine: number }> = []
    if (ctx.ast) {
      const ast = ctx.ast as ParseResult
      for (const tryBlock of ast.tryBlocks) {
        tryBlockBoundaries.push({ startLine: tryBlock.startLine, endLine: tryBlock.endLine })
      }
    }

    switch (language) {
      case 'typescript':
      case 'javascript':
        return this.detectJS(source, filePath)
      case 'python':
        return this.detectPython(source, filePath, tryBlockBoundaries, ctx.pythonAst)
      case 'java':
        return this.detectJava(source, filePath)
      case 'go':
        return this.detectGo(source, filePath)
      case 'rust':
        return this.detectRust(source, filePath)
      case 'php':
        return this.detectPHP(source, filePath)
      case 'ruby':
        return this.detectRuby(source, filePath)
      default:
        return []
    }
  }

  private detectJS(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配 catch(e) { — 只匹配头部，函数体通过花括号深度计数提取
    const catchStartRegex = /\bcatch\s*\(\s*(\w+)\s*\)\s*\{/g

    let match: RegExpExecArray | null

    while ((match = catchStartRegex.exec(source)) !== null) {
      const errorVar = match[1]
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)

      if (body !== null) {
        if (this.isSwallowedJS(body, errorVar)) {
          issues.push(this.createIssue(filePath, source, match.index, body.trim()))
        }
        // 跳过已处理的 catch 块，避免正则搜索块内内容
        catchStartRegex.lastIndex = openBraceIndex + body.length + 2
      }
    }

    return issues
  }

  private detectPython(source: string, filePath: string, tryBlockBoundaries: Array<{ startLine: number; endLine: number }>, pythonAst?: PythonASTResult): Issue[] {
    const issues: Issue[] = []

    // Python AST 桥接路径：使用 CPython 解析，100% 准确的 except 块分析
    if (pythonAst) {
      for (const tb of pythonAst.tryBlocks) {
        for (const handler of tb.handlers) {
          if (handler.type === 'finally') continue // finally 块不视为吞噬
          if (handler.isSwallowed) {
            const excType = handler.type ? `Exception ${handler.type}` : 'bare except'
            issues.push({
              rule: this.rule,
              severity: 'high',
              category: 'ai-code',
              file: filePath,
              line: handler.line,
              message: `异常被吞噬（${excType} 块中未对异常进行有效处理）`,
              snippet: `except${handler.type ? ' ' + handler.type : ''}:`,
              suggestion: '请在 except 块中添加适当的异常处理：重新抛出、记录日志并恢复、或转换为有意义的错误响应',
            })
          }
        }
      }
      return issues
    }

    // 回退路径：正则解析（无 python3 环境时使用）
    const exceptRegex = /^(\s*)except\s*(?:(\w+(?:\s+as\s+\w+)?)\s*)?:\s*\n((?:\1\s+.*\n)*)/gm

    let match: RegExpExecArray | null

    while ((match = exceptRegex.exec(source)) !== null) {
      const body = match[3]
      // 提取异常类型名（去掉可选的 as 变量部分）
      const exceptType = match[2] ? match[2].split(/\s+/)[0] : undefined

      // AST 增强：验证 except 是否在有效的 try 块内
      if (tryBlockBoundaries.length > 0) {
        const exceptLine = getLineNumber(source, match.index)
        const insideTry = tryBlockBoundaries.some(
          b => exceptLine >= b.startLine && exceptLine <= b.endLine,
        )
        if (!insideTry) continue
      }

      if (this.isSwallowedPython(body, exceptType)) {
        issues.push(this.createIssue(filePath, source, match.index, body.trim()))
      }
    }

    return issues
  }

  private detectJava(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配 catch (ExceptionType e) { — 只匹配头部
    const catchStartRegex = /\bcatch\s*\(\s*\w+(?:\s+\w+)?\s*\)\s*\{/g

    let match: RegExpExecArray | null

    while ((match = catchStartRegex.exec(source)) !== null) {
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)

      if (body !== null) {
        if (this.isSwallowedJava(body)) {
          issues.push(this.createIssue(filePath, source, match.index, body.trim()))
        }
        catchStartRegex.lastIndex = openBraceIndex + body.length + 2
      }
    }

    return issues
  }

  /** 检查 JS/TS catch 块是否吞噬异常 */
  private isSwallowedJS(body: string, errorVar: string): boolean {
    const noComments = body
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()

    // 空 catch 块
    if (noComments === '') return true

    const consoleOnly = noComments
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '' && l !== ';')

    if (consoleOnly.length === 0) return true

    // 多行 catch 体（≥2 行有意义的代码）→ 不算吞噬
    // 实际工程中，catch 块有日志+降级/清理等多步操作是常见模式
    if (consoleOnly.length >= 2) return false

    // 单行 catch 体：检查是否为有效处理
    if (consoleOnly.length === 1) {
      const line = consoleOnly[0]

      // console.warn/error/debug/info → 检查是否为有效处理
      if (/^\s*console\.(warn|error|debug|info)\s*\(/.test(line)) {
        // 只有错误变量本身（如 console.error(e)）→ 缺少描述性信息，仍视为吞噬
        if (/^\s*console\.\w+\s*\(\s*\w+\s*\)\s*;?\s*$/.test(line)) return true
        // 传入了错误变量 + 描述性字符串（如 console.warn('操作失败', err)）→ 有效处理
        if (new RegExp(`\\b${escapeRegex(errorVar)}\\b`).test(line)) return false
        // 传入了描述性字符串 + 其他参数（如 console.warn('描述', data)）→ 有效处理
        if (/console\.\w+\s*\([^)]*,/.test(line)) return false
        // console.warn/error 有描述性字符串（如 console.warn('操作失败')）→ 有效处理
        if (/^\s*console\.(warn|error)\s*\(/.test(line)) return false
        return true
      }

      // 只有 console.log（无错误变量引用）→ 吞噬
      if (/^\s*console\.log\s*\(/.test(line)) return true

      // 只有对错误变量的引用但无实际处理（如 console.error(e)）
      if (/^\s*console\.\w+\s*\(\s*\w+\s*\)\s*;?\s*$/.test(line)) return true
    }

    return false
  }

  /** 检查 Python except 块是否吞噬异常 */
  private isSwallowedPython(body: string, exceptionType?: string): boolean {
    const lines = body.split('\n').filter(l => l.trim() !== '')
    if (lines.length === 0) return true

    const noComments = lines.filter(l => !l.trim().startsWith('#'))
    if (noComments.length === 0) return true

    const meaningful = noComments.map(l => l.trim())

    // 新增：多行 except 体（≥2 行有意义的代码）→ 不算吞噬
    // 实际工程中，except 块有日志+降级/清理等多步操作是常见模式
    if (meaningful.length >= 2) return false

    if (meaningful.length === 1) {
      const line = meaningful[0]
      if (line === 'pass' || line === '...') {
        // 识别合理静默模式：特定异常类型的 pass/... 是标准写法
        // OSError: 文件操作（文件不存在则跳过，是常见模式）
        // FileNotFoundError / PermissionError: OSError 子类，同理
        // ImportError: 可选依赖检查
        // asyncio.CancelledError: 任务取消
        // KeyboardInterrupt / StopIteration: 系统/迭代控制
        if (exceptionType && /^(OSError|FileNotFoundError|PermissionError|ImportError|asyncio\.CancelledError|KeyboardInterrupt|StopIteration)$/.test(exceptionType)) {
          return false
        }
        return true
      }
      if (/^print\(.*\)$/.test(line)) return true

      // 新增：logger.exception(...) 含完整 traceback → 有效处理
      if (/^logger\.exception\s*\(/.test(line)) return false
      // 新增：logging.exception() 同理
      if (/^logging\.exception\s*\(/.test(line)) return false
      // 新增：logger.opt(exception=True) loguru 专用 → 有效处理
      if (/^logger\.opt\s*\(\s*exception\s*[:=]\s*True\s*\)/.test(line)) return false
      // 新增：logger 调用中引用了异常变量（如 e, exc, err, exception, error, ex）→ 有效处理
      if (/^logger\.\w+\(.*\b(?:e|exc|err|exception|error|ex)\b/.test(line)) return false
      // 新增：logging 调用中引用了异常变量 → 有效处理
      if (/^logging\.\w+\(.*\b(?:e|exc|err|exception|error|ex)\b/.test(line)) return false
      
      // 新增：traceback.format_exc() / traceback.print_exc() → 有效处理
      if (/traceback\.(format_exc|print_exc)\s*\(/.test(line)) return false
      
      // 新增：sys.exc_info() 使用 → 有效处理
      if (/sys\.exc_info\s*\(/.test(line)) return false

      // 剩余的 logger.debug/info/warning/error（无异常变量引用）仍视为吞噬
      if (/^(?:logging|logger)\.\w+\(.*\)$/.test(line)) return true
    }

    return false
  }

  /** 检查 Java catch 块是否吞噬异常 */
  private isSwallowedJava(body: string): boolean {
    const noComments = body
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()

    if (noComments === '') return true

    // 只有 printStackTrace / log
    const lines = noComments
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '' && l !== ';')

    if (lines.length === 0) return true

    const allLogOrPrint = lines.every(l =>
      /^\s*(?:e\.)?printStackTrace\(\)\s*;?\s*$/.test(l) ||
      /^\s*(?:log|logger|LOG)\.\w+\(.*\)\s*;?\s*$/.test(l)
    )
    if (allLogOrPrint) return true

    return false
  }

  /** 检测 Go 中的错误吞噬模式 */
  private detectGo(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []
    const lines = source.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // 1. 显式忽略错误: xxx, _ := ...
      if (/,\s*_\s*:=/.test(lines[i])) {
        issues.push({
          rule: this.rule,
          severity: 'high',
          category: 'ai-code',
          file: filePath,
          line: i + 1,
          message: 'Go 错误被显式忽略（使用 _ 丢弃错误值）',
          snippet: line,
          suggestion: '请处理错误或至少记录日志：result, err := ...; if err != nil { ... }',
        })
        continue
      }

      // 2. if err != nil { } 空块或仅 log
      if (/if\s+err\s*!=\s*nil\s*\{/.test(lines[i])) {
        const block = this.extractGoBlock(lines, i)
        if (block !== null && this.isSwallowedGo(block)) {
          issues.push({
            rule: this.rule,
            severity: 'high',
            category: 'ai-code',
            file: filePath,
            line: i + 1,
            message: 'Go 错误处理块为空或仅记录日志，未对错误进行有效处理',
            snippet: line,
            suggestion: '请在错误处理块中添加适当的处理：返回错误、重试、或降级处理',
          })
        }
      }
    }
    return issues
  }

  /** 提取 Go 代码块内容（从 if err != nil { 到对应的 }） */
  private extractGoBlock(lines: string[], startLine: number): string | null {
    let depth = 0
    const blockLines: string[] = []
    for (let i = startLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
      blockLines.push(lines[i])
      if (depth === 0) break
    }
    // 返回块内容（不含首尾行的花括号行）
    if (blockLines.length <= 1) return ''
    return blockLines.slice(1, -1).join('\n')
  }

  /** 检查 Go 错误处理块是否吞噬错误 */
  private isSwallowedGo(body: string): boolean {
    const noComments = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (noComments === '') return true

    const lines = noComments.split('\n').map(l => l.trim()).filter(l => l !== '')
    if (lines.length === 0) return true

    // 只有 log.Println / log.Printf / fmt.Println
    const logOnly = lines.every(l =>
      /^\s*(?:log|fmt)\.\w+\s*\(/.test(l)
    )
    if (logOnly && lines.length <= 2) return true

    return false
  }

  /** 检测 Rust 中的错误吞噬模式 */
  private detectRust(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 检测 .unwrap() 调用（可能 panic）
    const unwrapRegex = /\.unwrap\s*\(\)/g
    let match: RegExpExecArray | null
    while ((match = unwrapRegex.exec(source)) !== null) {
      const line = this.getLineAt(source, match.index)
      // 在测试代码中 unwrap 是正常的
      if (/#\[test\]/.test(source.substring(Math.max(0, match.index - 500), match.index))) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'ai-code',
        file: filePath,
        line: getLineNumber(source, match.index),
        message: 'Rust .unwrap() 调用可能导致 panic，建议使用 match 或 ? 操作符处理错误',
        snippet: line.trim(),
        suggestion: '使用 match result { Ok(v) => ..., Err(e) => ... } 或 ? 操作符安全地处理错误',
      })
    }

    // 检测 let _ = 忽略 Result
    const ignoreRegex = /let\s+_\s*=\s*.+/g
    while ((match = ignoreRegex.exec(source)) !== null) {
      const line = this.getLineAt(source, match.index)
      // 检查是否忽略了 Result 类型
      if (/Result|Ok|Err|\.ok\(\)/.test(line) || !/=\s*\d|=\s*"/.test(line)) {
        issues.push({
          rule: this.rule,
          severity: 'high',
          category: 'ai-code',
          file: filePath,
          line: getLineNumber(source, match.index),
          message: 'Rust Result 被显式忽略（let _ = ...），错误未处理',
          snippet: line.trim(),
          suggestion: '请使用 match 或 if let 处理 Result，或至少在错误时记录日志',
        })
      }
    }

    return issues
  }

  /** 获取源码中指定索引所在的行内容 */
  private getLineAt(source: string, index: number): string {
    const start = source.lastIndexOf('\n', index) + 1
    const end = source.indexOf('\n', index)
    return source.substring(start, end === -1 ? source.length : end)
  }

  /** 检测 PHP 中的异常吞噬模式 */
  private detectPHP(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    const catchStartRegex = /\bcatch\s*\(\s*\w+\s+\$\w+\s*\)\s*\{/g
    let match: RegExpExecArray | null

    while ((match = catchStartRegex.exec(source)) !== null) {
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)

      if (body !== null) {
        if (this.isSwallowedPHP(body)) {
          issues.push(this.createIssue(filePath, source, match.index, body.trim()))
        }
        catchStartRegex.lastIndex = openBraceIndex + body.length + 2
      }
    }
    return issues
  }

  /** 检查 PHP catch 块是否吞噬异常 */
  private isSwallowedPHP(body: string): boolean {
    const noComments = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/#.*$/gm, '').trim()
    if (noComments === '') return true

    const lines = noComments.split('\n').map(l => l.trim()).filter(l => l !== '' && l !== ';')
    if (lines.length === 0) return true

    // 只有 echo / print / var_dump / error_log
    const allPrintOnly = lines.every(l =>
      /^\s*(?:echo|print|var_dump|error_log|error_reporting)\s*\(/.test(l)
        || /^\s*\$\w+->getMessage\(\)/.test(l)
    )
    if (allPrintOnly) return true

    return false
  }

  /** 检测 Ruby 中的异常吞噬模式 */
  private detectRuby(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配 rescue 块
    const rescueRegex = /^\s*rescue(?:\s+\w*(?:\s*=>\s*\w+)?)?\s*\n((?:\s+.*\n)*)/gm
    let match: RegExpExecArray | null
    while ((match = rescueRegex.exec(source)) !== null) {
      const body = match[1]
      if (this.isSwallowedRuby(body)) {
        issues.push(this.createIssue(filePath, source, match.index, body.trim()))
      }
    }

    // 匹配单行 rescue: xxx rescue nil
    const inlineRescueRegex = /\brescue\s+(?:nil|false|null)\s*$/gm
    while ((match = inlineRescueRegex.exec(source)) !== null) {
      issues.push({
        rule: this.rule,
        severity: 'high',
        category: 'ai-code',
        file: filePath,
        line: getLineNumber(source, match.index),
        message: 'Ruby 异常被 rescue nil 吞噬',
        snippet: match[0].trim(),
        suggestion: '请在 rescue 块中添加适当的异常处理',
      })
    }

    return issues
  }

  /** 检查 Ruby rescue 块是否吞噬异常 */
  private isSwallowedRuby(body: string): boolean {
    const lines = body.split('\n').filter(l => l.trim() !== '' && !l.trim().startsWith('#'))
    if (lines.length === 0) return true

    const meaningful = lines.map(l => l.trim())
    if (meaningful.length === 1) {
      const line = meaningful[0]
      if (line === 'nil' || line === 'retry') return true
      // 只有 puts / logger
      if (/^(?:puts|p|print|logger)\.\w+\(/.test(line)) return true
    }

    return false
  }

  private createIssue(filePath: string, source: string, index: number, snippet: string): Issue {
    return {
      rule: this.rule,
      severity: 'high',
      category: 'ai-code',
      file: filePath,
      line: getLineNumber(source, index),
      message: '异常被吞噬，catch/except 块中未对异常进行有效处理',
      snippet: snippet || '(空 catch 块)',
      suggestion: '请在 catch/except 块中添加适当的异常处理：重新抛出、记录日志并恢复、或转换为有意义的错误响应',
    }
  }

  }
