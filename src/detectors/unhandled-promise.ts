/**
 * AIDE - 未处理 Promise 检测器
 * 检测 .then() 无 .catch()、async 函数调用无 await 且无 .catch()、
 * await 关键操作缺少 try/catch
 */

import { isTestFile } from '../types/index.js'
import { getLineNumber } from '../core/utils.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'
import type { ParseResult } from '../core/ast-parser.js'

/** 关键操作关键词（需要错误处理） */
const CRITICAL_OPERATIONS = /\b(?:fetch|axios|http|request|get|post|put|delete|patch|head)\b|\b(?:db|database|mongo|redis|sql|query|execute|insert|update|remove)\b|\b(?:writeFile|readFile|write|save|create|remove|unlink|mkdir|rmdir)\b/i

export class UnhandledPromiseDetector implements Detector {
  rule = 'unhandled-promise'
  category = 'ai-code' as const
  description = '检测未处理的 Promise（.then() 无 .catch()、async 调用无 await、关键操作缺 try/catch）'
  severity = 'medium' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath, ast } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    switch (language) {
      case 'typescript':
      case 'javascript':
        return this.detectJS(source, filePath, ast)
      case 'python':
        return this.detectPython(source, filePath, ast)
      case 'java':
        return this.detectJava(source, filePath)
      default:
        return []
    }
  }

  private detectJS(source: string, filePath: string, ast?: unknown): Issue[] {
    const issues: Issue[] = []

    // 1. .then() 链无 .catch()
    issues.push(...this.detectThenWithoutCatch(source, filePath))

    // 2. async 函数调用无 await 且无 .catch()
    issues.push(...this.detectFloatingPromise(source, filePath))

    // 3. await 关键操作缺少 try/catch
    issues.push(...this.detectAwaitWithoutTryCatch(source, filePath, ast))

    return issues
  }

  private detectJava(source: string, filePath: string): Issue[] {
  const issues: Issue[] = []
  
  // 检测 CompletableFuture 调用无异常处理
  const cfutureRegex = /CompletableFuture\.\w+\s*\([^)]*\)/g
  let match: RegExpExecArray | null
  while ((match = cfutureRegex.exec(source)) !== null) {
    const line = this.getLineAt(source, match.index)
    // 如果没有 .exceptionally() 或 .handle()
    const remainingLine = source.substring(match.index, source.indexOf('\n', match.index))
    if (!/\.exceptionally\(|\.handle\(/.test(remainingLine)) {
      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'ai-code',
        file: filePath,
        line: getLineNumber(source, match.index),
        message: 'Java CompletableFuture 调用缺少异常处理',
        snippet: line.trim().slice(0, 80),
        suggestion: '请添加 .exceptionally() 或 .handle() 来处理异步操作的异常',
      })
    }
  }
  
  // 检测 Future.get() 无 try-catch
  const futureGetRegex = /\.get\s*\(\s*\)/g
  while ((match = futureGetRegex.exec(source)) !== null) {
    const line = this.getLineAt(source, match.index)
    if (/Future|future/.test(line) && !this.isInsideTryBlock(source, match.index)) {
      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'ai-code',
        file: filePath,
        line: getLineNumber(source, match.index),
        message: 'Java Future.get() 调用缺少 try-catch',
        snippet: line.trim().slice(0, 80),
        suggestion: '请将 Future.get() 包裹在 try-catch 块中处理 ExecutionException 和 InterruptedException',
      })
    }
  }
  
  return issues
}

private getLineAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1
  const end = source.indexOf('\n', index)
  return source.substring(start, end === -1 ? source.length : end)
}

  private detectPython(source: string, filePath: string, ast?: unknown): Issue[] {
    const issues: Issue[] = []

    // 检测 await 关键操作无 try/except
    const awaitRegex = /^\s*await\s+(.+)$/gm
    let match: RegExpExecArray | null

    while ((match = awaitRegex.exec(source)) !== null) {
      const expr = match[1].trim()

      if (!CRITICAL_OPERATIONS.test(expr)) continue

      const lineNumber = getLineNumber(source, match.index)

      // AST 快速路径：检查 tryBlocks 索引
      if (ast) {
        const parseResult = ast as ParseResult
        if (this.isInsideTryBlockAST(parseResult, lineNumber)) continue
      }

      // 回退路径：源码扫描
      if (!this.isInsideTryBlock(source, match.index)) {
        // 检查函数级 try-catch（入口级 try-catch 模式）
        if (this.isInsideFunctionTryCatch(source, match.index)) continue
        // 检查事务模式
        if (this.isTransactionPattern(source, match.index)) continue

        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'ai-code',
          file: filePath,
          line: getLineNumber(source, match.index),
          message: `await 关键操作 "${expr.slice(0, 50)}" 缺少 try/except`,
          snippet: match[0].trim(),
          suggestion: '请将 await 关键操作包裹在 try/except 块中处理可能的异常',
        })
      }
    }

    return issues
  }

  /** 检测 .then() 链无 .catch() */
  private detectThenWithoutCatch(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配 .then(...).then(...) 链，检查是否以 .catch() 结尾
    // 使用逐行扫描 + 状态跟踪来处理跨行链式调用
    const lines = source.split('\n')
    let chainStartLine = -1
    let chainStartIndex = -1
    let hasCatch = false
    let inChain = false
    let chainSnippet = ''

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (/\.then\s*\(/.test(line) && !inChain) {
        inChain = true
        chainStartLine = i + 1
        chainStartIndex = source.indexOf(line)
        hasCatch = false
        chainSnippet = line.trim()
      }

      if (inChain) {
        if (i + 1 !== chainStartLine) {
          chainSnippet += ' ' + line.trim()
        }
        if (/\.catch\s*\(/.test(line)) {
          hasCatch = true
        }
        // 链结束：遇到分号、语句结束，或不再有 .then/.catch
        if (/;\s*$/.test(line) || (/[^)]$/.test(line.trim()) && !/\.then|\.catch/.test(line))) {
          if (!hasCatch && /\.then/.test(chainSnippet)) {
            // 排除低风险场景
            if (!this.isLowRiskThenChain(chainSnippet, filePath)) {
              issues.push({
                rule: this.rule,
                severity: 'medium',
                category: 'ai-code',
                file: filePath,
                line: chainStartLine,
                message: '.then() 链缺少 .catch() 错误处理',
                snippet: chainSnippet.slice(0, 80),
                suggestion: '请在 .then() 链末尾添加 .catch() 处理可能的 Promise 拒绝',
              })
            }
          }
          inChain = false
          chainSnippet = ''
        }
      }
    }

    // 处理链未结束的情况
    if (inChain && !hasCatch && /\.then/.test(chainSnippet)) {
      // 排除低风险场景
      if (!this.isLowRiskThenChain(chainSnippet, filePath)) {
        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'ai-code',
          file: filePath,
          line: chainStartLine,
          message: '.then() 链缺少 .catch() 错误处理',
          snippet: chainSnippet.slice(0, 80),
          suggestion: '请在 .then() 链末尾添加 .catch() 处理可能的 Promise 拒绝',
        })
      }
    }

    return issues
  }

  /** 检测 async 函数调用无 await 且无 .catch() */
  private detectFloatingPromise(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    const lines = source.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const fullLine = lines[i].trim()
      if (!fullLine) continue

      const callMatch = /^(\w+(?:\.\w+)*)\s*\(/.exec(fullLine)
      if (!callMatch) continue

      // 跳过已有 await / return / 赋值 / 条件 / .then / .catch 的行
      if (/^\s*(?:await|return|const|let|var|=|if|while|for|\.then|\.catch)/.test(fullLine)) continue
      // 跳过函数声明、class 声明等
      if (/^\s*(?:function|class|export|import|interface|type)\b/.test(fullLine)) continue
      // 跳过在 .then/.catch 链中的调用
      if (/\.\s*(?:then|catch)\s*\(/.test(fullLine)) continue

      // 检查是否为已知返回 Promise 的调用
      if (this.isLikelyPromiseCall(fullLine)) {
        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'ai-code',
          file: filePath,
          line: i + 1,
          message: `异步调用 "${fullLine.slice(0, 50)}" 未使用 await 且未添加 .catch()`,
          snippet: fullLine.slice(0, 80),
          suggestion: '请添加 await 或 .catch() 来处理此异步操作的可能错误',
        })
      }
    }

    return issues
  }

  /** 检测 await 关键操作缺少 try/catch */
  private detectAwaitWithoutTryCatch(source: string, filePath: string, ast?: unknown): Issue[] {
    const issues: Issue[] = []

    const awaitRegex = /\bawait\s+(.+?)(?:;|\n)/g
    let match: RegExpExecArray | null

    while ((match = awaitRegex.exec(source)) !== null) {
      const expr = match[1].trim()

      if (!CRITICAL_OPERATIONS.test(expr)) continue

      const lineNumber = getLineNumber(source, match.index)

      // AST 快速路径：检查 tryBlocks 索引
      if (ast) {
        const parseResult = ast as ParseResult
        if (this.isInsideTryBlockAST(parseResult, lineNumber)) continue
      }

      // 回退路径：源码扫描
      if (!this.isInsideTryBlock(source, match.index)) {
        // 检查函数级 try-catch（入口级 try-catch 模式）
        if (this.isInsideFunctionTryCatch(source, match.index)) continue
        // 检查事务模式
        if (this.isTransactionPattern(source, match.index)) continue

        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'ai-code',
          file: filePath,
          line: getLineNumber(source, match.index),
          message: `await 关键操作 "${expr.slice(0, 50)}" 缺少 try/catch`,
          snippet: match[0].trim(),
          suggestion: '请将 await 关键操作包裹在 try/catch 块中处理可能的异常',
        })
      }
    }

    return issues
  }

  /** 判断是否为可能返回 Promise 的调用 */
  private isLikelyPromiseCall(line: string): boolean {
    // fetch / axios / 其他常见异步 API
    return /\b(?:fetch|axios)\b/.test(line) ||
      // 以 Async 结尾的函数调用
      /\w+Async\s*\(/.test(line) ||
      // db 操作
      /\b(?:db|database|mongo|redis|sql)\.\w+\s*\(/.test(line)
  }

  /** 使用 AST tryBlocks 快速判断行号是否在 try 块内 */
  private isInsideTryBlockAST(ast: ParseResult, lineNumber: number): boolean {
    for (const tryBlock of ast.tryBlocks) {
      if (lineNumber >= tryBlock.startLine && lineNumber <= tryBlock.endLine) {
        return true
      }
    }
    return false
  }

  /** 检查给定位置是否在 try 块内 */
  private isInsideTryBlock(source: string, index: number): boolean {
    const lines = source.split('\n')
    // 找到 index 所在行号
    let charCount = 0
    let targetLine = 0
    for (let i = 0; i < lines.length; i++) {
      if (charCount + lines[i].length >= index) {
        targetLine = i
        break
      }
      charCount += lines[i].length + 1 // +1 for \n
    }

    const currentIndent = lines[targetLine].length - lines[targetLine].trimStart().length

    // 向上搜索：找缩进更小的 try 行
    for (let i = targetLine - 1; i >= 0; i--) {
      const line = lines[i]
      const trimmed = line.trim()
      const lineIndent = line.length - line.trimStart().length

      // 到达函数/类边界停止
      if (lineIndent === 0 && /(?:^|\s)(?:def|async\s+def|function|class)\b/.test(trimmed)) break

      // 缩进比当前行小，检查是否是 try
      if (lineIndent < currentIndent) {
        // Python: try:
        if (/^\s*try\s*:/.test(line)) {
          // 找到 try，检查后面是否有对应的 except/finally
          for (let j = i + 1; j < lines.length; j++) {
            const nextTrimmed = lines[j].trim()
            const nextIndent = lines[j].length - lines[j].trimStart().length
            // except/finally 与 try 同级缩进
            if (nextIndent === lineIndent && /^\s*(except|finally)\b/.test(lines[j])) {
              return true
            }
            // 遇到同级的非空非注释行且不是 except/finally，说明 try 没有配对
            if (nextIndent <= lineIndent && nextTrimmed !== '' && !nextTrimmed.startsWith('#')) {
              break
            }
          }
        }
        // JS/TS/Java: try {
        if (/^\s*try\s*\{/.test(line)) {
          // 使用花括号深度计数检查 try 后面是否有 catch/finally
          let braceDepth = 0
          let foundOpenBrace = false
          for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
              if (ch === '{') { braceDepth++; foundOpenBrace = true }
              if (ch === '}') braceDepth--
              // try 块的 } 后面紧跟 catch/finally
              if (foundOpenBrace && braceDepth === 0) {
                const afterClose = lines[j].substring(lines[j].indexOf('}') + 1).trimStart()
                if (/^(catch|finally)\b/.test(afterClose)) return true
                // 检查下一行是否是 catch/finally
                if (j + 1 < lines.length) {
                  const nextTrimmed = lines[j + 1].trim()
                  if (/^(catch|finally)\b/.test(nextTrimmed)) return true
                }
                return false
              }
            }
            if (foundOpenBrace && braceDepth <= 0) break
          }
        }
      }
    }

    return false
  }

  /** 检查 await 是否在函数级别的 try-catch 内（入口级 try-catch 模式） */
  private isInsideFunctionTryCatch(source: string, index: number): boolean {
    const lines = source.split('\n')
    // 找到 index 所在行号（0-based）
    let charCount = 0
    let targetLine = 0
    for (let i = 0; i < lines.length; i++) {
      if (charCount + lines[i].length >= index) {
        targetLine = i
        break
      }
      charCount += lines[i].length + 1
    }

    // 向上搜索函数边界
    let funcBodyStartLine = -1

    for (let i = targetLine; i >= 0; i--) {
      const trimmed = lines[i].trim()

      // Python: async def / def
      if (/^(?:async\s+)?def\s/.test(trimmed)) {
        // 找到以 : 结尾的行（处理多行函数定义）
        for (let j = i; j < lines.length; j++) {
          if (lines[j].trimEnd().endsWith(':')) {
            funcBodyStartLine = j + 1
            break
          }
        }
        break
      }

      // JS: function 声明
      if (/(?:async\s+)?function\s*\w*\s*\(/.test(trimmed)) {
        funcBodyStartLine = this.findBlockBodyStartLine(lines, i)
        break
      }

      // JS: 箭头函数（块体在同一行）
      if (/=>\s*\{/.test(trimmed)) {
        funcBodyStartLine = i + 1
        break
      }

      // JS: exports.main / exports.handler
      if (/exports\.(?:main|handler)\s*=/.test(trimmed)) {
        funcBodyStartLine = this.findBlockBodyStartLine(lines, i)
        break
      }

      // JS: 箭头函数（块体在下一行）
      if (/=>\s*$/.test(trimmed)) {
        funcBodyStartLine = this.findBlockBodyStartLine(lines, i)
        break
      }
    }

    if (funcBodyStartLine === -1 || funcBodyStartLine >= lines.length) return false

    // 检查函数体是否以 try 块开始（跳过声明和注释）
    for (let i = funcBodyStartLine; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#')) continue

      // 跳过不含 await 的简单声明/赋值
      if (!/\bawait\b/.test(trimmed) && /^(?:const|let|var\s+)?\w+\s*=/.test(trimmed)) continue

      // 检查是否以 try 开始
      if (/^try\s*[\{:]/.test(trimmed)) return true

      // 第一个有效语句不是 try
      break
    }

    return false
  }

  /** 检查 await 是否属于事务模式（await 赋值给事务变量，且下一行紧跟 try 块） */
  private isTransactionPattern(source: string, index: number): boolean {
    const lines = source.split('\n')
    // 找到 index 所在行号（0-based）
    let charCount = 0
    let targetLine = 0
    for (let i = 0; i < lines.length; i++) {
      if (charCount + lines[i].length >= index) {
        targetLine = i
        break
      }
      charCount += lines[i].length + 1
    }

    const currentLine = lines[targetLine].trim()

    // 检查当前行是否将 await 结果赋值给事务变量
    if (!/\bawait\b/.test(currentLine)) return false
    if (!/\b(?:transaction|tx|txn|sess|session)\s*=/.test(currentLine)) return false

    // 检查下一非空行是否以 try 开始
    for (let i = targetLine + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#')) continue
      return /^try\s*[\{:]/.test(trimmed)
    }

    return false
  }

  /** 找到代码块的开始行（{ 后的下一行，0-based） */
  private findBlockBodyStartLine(lines: string[], startLine: number): number {
    for (let j = startLine; j < lines.length; j++) {
      if (lines[j].includes('{')) {
        return j + 1
      }
    }
    return -1
  }

  /** 判断 .then() 链是否为低风险场景 */
  private isLowRiskThenChain(snippet: string, filePath: string): boolean {
    // 1. 剪贴板操作（navigator.clipboard）
    if (/navigator\.clipboard\.\w+\s*\(/.test(snippet)) return true
    
    // 2. console.log/warn/error 调试输出
    if (/console\.\w+\s*\(/.test(snippet)) return true
    
    // 3. UI 提示/通知（showError, alert, toast 等）
    if (/\b(?:showError|showSuccess|showWarning|showInfo|alert|toast|notification|notify)\s*\(/.test(snippet)) return true
    
    // 4. DOM 操作（classList.add/remove/toggle）
    if (/classList\.\w+\(/.test(snippet)) return true
    
    // 5. 单行链（风险较低）
    const chainParts = snippet.split(/\.then\s*\(/)
    if (chainParts.length <= 2) return true  // 只有一个 .then()
    
    // 6. 测试文件中的 .then()
    if (/test|spec|__test__|__spec__/.test(filePath)) return true
    
    return false
  }
}
