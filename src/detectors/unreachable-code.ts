/**
 * AIDE - 不可达代码检测器
 * 检测 return/throw 后的不可达代码，以及永远为真/假的条件表达式
 */

import { stripComments, stripStrings } from '../core/type-inferencer.js'
import { isTestFile } from '../types/index.js'
import type { Detector, DetectorContext, Issue, Confidence } from '../types/index.js'
import type { ParseResult } from '../core/ast-parser.js'

export class UnreachableCodeDetector implements Detector {
  rule = 'unreachable-code'
  category = 'correctness' as const
  description = '检测不可达代码和恒真/恒假条件'
  severity = 'low' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, filePath } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    const issues: Issue[] = []

    // 当 AST 可用时，构建函数边界集合用于更精确的作用域判断
    const functionBoundaries = new Map<number, number>()  // startLine -> endLine
    if (ctx.ast) {
      const ast = ctx.ast as ParseResult
      for (const fn of ast.functions) {
        functionBoundaries.set(fn.startLine, fn.endLine)
      }
    }

    const lines = source.split('\n')

    // 缩进栈：记录每层缩进及其类型
    const indentStack: Array<{ indent: number; type: 'function' | 'loop' | 'condition' | 'class' | 'try' | 'except' }> = []
    // 函数作用域栈：记录每个函数层级的 foundReturn
    const functionScopeStack: boolean[] = [false]
    // 当前函数深度（0 = 顶层）
    let functionDepth = 0
    // 当前循环深度
    let loopDepth = 0
    // 当前类深度（类体内的 return 不应影响类体其他成员）
    let classDepth = 0
    // 当前函数作用域内是否发现了 return
    let foundReturn = false
    // return 语句的缩进级别（用于判断后续代码是否不可达）
    let returnIndent = -1
    // 多行 return 追踪：括号未闭合时继续
    let inMultilineReturn = false
    let parenDepth = 0
    // 追踪 if 块中是否有 return（用于判断 if-return 后的代码是否可达）
    let ifHasReturn = false
    // Python docstring 跟踪
    let inDocstring = false
    // 赋值语句多行字符串跟踪（如 PREDICT_SYSTEM_PROMPT = """..."""）
    let inMultilineString = false
    let stringQuote: '"""' | "'''" | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1
      const trimmed = line.trim()

      // 计算当前行缩进
      const indent = line.length - line.trimStart().length

      // Python docstring 跟踪：跳过三引号内的内容
      if (inDocstring) {
        // 检查是否结束 docstring（行内包含 """ 或 '''）
        if (trimmed.includes('"""') || trimmed.includes("'''")) {
          inDocstring = false
        }
        // docstring 内的行不参与检测，也不参与缩进栈管理
        // （docstring 内的缩进/空行不代表代码作用域变化，
        //   空行 indent=0 会错误弹出所有函数作用域，
        //   导致 functionDepth 降低，嵌套函数内的 return 不再被过滤）
        continue
      }
      // 检查是否开始 docstring
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        // 单行 docstring："""xxx""" 在同一行
        if ((trimmed.match(/"""/g) || []).length >= 2 || (trimmed.match(/'''/g) || []).length >= 2) {
          // 单行 docstring，跳过此行
          continue
        }
        // 多行 docstring 开始
        inDocstring = true
        continue
      }

      // 赋值语句多行字符串跟踪（如 PREDICT_SYSTEM_PROMPT = """..."""）
      if (inMultilineString) {
        // 检查是否结束多行字符串
        if (stringQuote && trimmed.includes(stringQuote)) {
          inMultilineString = false
          stringQuote = null
        }
        // 多行字符串内的行不参与任何检测（不管理缩进栈）
        continue
      }
      // 检测赋值语句中的三引号字符串开始（非 docstring 场景）
      // 匹配: VAR = """... 或 VAR = '''... 
      const tripleQuoteMatch = trimmed.match(/^(\w+(?:\[[\w,\s]+\])?\s*=\s*)(["']{3})/)
      if (tripleQuoteMatch) {
        const quote = tripleQuoteMatch[2] as '"""' | "'''"
        // 检查是否单行完（开始和结束在同一行）
        const afterEquals = trimmed.substring(tripleQuoteMatch[0].length)
        if (!afterEquals.includes(quote)) {
          inMultilineString = true
          stringQuote = quote
        }
        // 无论单行完还是多行开始，此行都跳过检测
        continue
      }

      // 空行和注释行：仍需参与缩进栈管理（退出作用域），但不做检测
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
        // 缩进减少时需要退出作用域
        // 但空行/注释不应弹出函数或类作用域——
        // Python 中函数体内的空行可能 indent=0（如 import 语句后的空行），
        // 这不代表函数结束；函数作用域应只由后续实际代码行的缩进来判定。
        while (indentStack.length > 0 && indent < indentStack[indentStack.length - 1].indent) {
          const popped = indentStack[indentStack.length - 1]
          // 跳过函数/类作用域——留给实际代码行处理
          if (popped.type === 'function' || popped.type === 'class') {
            break
          }
          indentStack.pop()!
          if (popped.type === 'condition' || popped.type === 'try' || popped.type === 'except') {
            foundReturn = false
            returnIndent = -1
            ifHasReturn = false
          } else if (popped.type === 'loop') {
            loopDepth--
          }
        }
        continue
      }

      const normalizedLine = stripStrings(stripComments(trimmed, ctx.language), ctx.language)

      // 处理多行 return 表达式
      if (inMultilineReturn) {
        parenDepth += this.countExpressionDepth(normalizedLine)
        if (parenDepth <= 0) {
          inMultilineReturn = false
          parenDepth = 0
        }
        continue
      }

      // 当 foundReturn 为 true 时，检查当前行是否不可达
      if (foundReturn && indent <= returnIndent && trimmed.length > 0) {
        // 守卫子句模式（guard clause）：
        // if (x) { return; } 或 if x: return
        // 之后的代码仍然可达（if 条件不满足时会跳过 if 块）
        // 只有当 if 和 else 都有 return 时，if/else 之后的代码才不可达
        // 检查 return 是否在 condition 块内：如果缩进栈中有 condition 类型，
        // 且 return 的缩进 > condition 的缩进，说明 return 在 condition 分支内
        const returnInCondition = indentStack.some(
          s => s.type === 'condition' && returnIndent > s.indent
        )
        if (returnInCondition) {
          // return 在 if/elif/else 分支内，之后的代码仍可达
          // 不报告，但也不重置 foundReturn（让缩进栈弹出时处理）
        } else if (this.isReturnOrThrow(trimmed)) {
          // return/throw/raise 是控制流语句，不是死代码
          // 重置 foundReturn，让后续检测从新的 return 开始
          foundReturn = false
          returnIndent = -1
        } else if (!trimmed.startsWith('}') && !trimmed.startsWith(']') && !trimmed.startsWith(')')
          && !this.isNewBlockStart(trimmed)) {
          // 判断置信度：如果只有单行不可达代码（非连续多行），置信度降低
          // 连续多行不可达代码更可能是真实的死代码
          const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : ''
          const isIsolated = !nextLine || nextLine.startsWith('}') || nextLine.startsWith(']')
            || nextLine.startsWith(')') || this.isNewBlockStart(nextLine)
            || nextLine === '' || nextLine.startsWith('//') || nextLine.startsWith('#')
          const confidence: Confidence = isIsolated ? 'low' : 'medium'
          issues.push({
            rule: this.rule,
            severity: this.severity,
            confidence,
            category: this.category,
            file: filePath,
            line: lineNum,
            message: 'return/throw 之后的代码不可达',
            snippet: trimmed,
            suggestion: '删除不可达的代码，或将 return/throw 移到正确的位置',
          })
          // 只报告一次，不重复标记后续不可达行
          // 但保持 foundReturn 状态，直到作用域退出
        } else {
          // 遇到新的代码块开始（if/def/class/对象属性等），重置 foundReturn
          // 因为这些结构不受前面 return 的影响
          foundReturn = false
          returnIndent = -1
        }
      }

      // 检测缩进减少 → 离开作用域
      // Python 等语言中，同缩进也意味着退出前一个块
      // 例如：if x: return \n next_line — next_line 和 if 同缩进，说明已退出 if 块
      while (indentStack.length > 0 && indent <= indentStack[indentStack.length - 1].indent) {
        const popped = indentStack.pop()!
        if (popped.type === 'function') {
          // 离开函数作用域，恢复外层函数的 foundReturn 状态
          functionDepth--
          foundReturn = functionScopeStack.pop() || false
          returnIndent = -1
          ifHasReturn = false
        } else if (popped.type === 'loop') {
          loopDepth--
          // 离开循环时不重置 foundReturn（循环外的代码可能仍不可达）
        } else if (popped.type === 'condition') {
          // 离开条件块：如果 if 块内有 return 但没有 else 分支，
          // if 块之后的代码仍然可达（if 条件不满足时会跳过 if 块）
          // 只有 if+else 都有 return 时，if/else 之后的代码才不可达
          // 这里简单处理：离开 if 块时重置 foundReturn
          foundReturn = false
          returnIndent = -1
          ifHasReturn = false
        } else if (popped.type === 'class') {
          // 离开类作用域，恢复 foundReturn 状态
          classDepth--
          foundReturn = functionScopeStack.pop() || false
          returnIndent = -1
          ifHasReturn = false
        } else if (popped.type === 'try') {
          // 离开 try 块：try 块内的 return 不影响 try 之后的代码
          // （因为 try 块可能抛异常，进入 except）
          foundReturn = false
          returnIndent = -1
          ifHasReturn = false
        } else if (popped.type === 'except') {
          // 离开 except/finally 块：重置 foundReturn
          foundReturn = false
          returnIndent = -1
          ifHasReturn = false
        }
      }

      // 检测函数定义
      if (this.isFunctionStart(trimmed)) {
        // 保存当前函数作用域的 foundReturn 状态
        functionScopeStack.push(foundReturn)
        functionDepth++
        foundReturn = false
        returnIndent = -1
        indentStack.push({ indent, type: 'function' })
        continue
      }

      // 检测类定义 — 类体内的 return 不应影响类体其他成员
      if (this.isClassStart(trimmed)) {
        functionScopeStack.push(foundReturn)
        classDepth++
        foundReturn = false
        returnIndent = -1
        indentStack.push({ indent, type: 'class' })
        continue
      }

      // 检测循环
      if (this.isLoopStart(trimmed)) {
        loopDepth++
        indentStack.push({ indent, type: 'loop' })
        continue
      }

      // 检测条件块
      if (this.isConditionStart(trimmed)) {
        // else / elif / else if 是 if 的替代分支，不应继承 foundReturn
        const withoutClosingBrace = trimmed.startsWith('}') ? trimmed.substring(1).trimStart() : trimmed
        if (/^\s*(else|elif|else\s+if)\b/.test(withoutClosingBrace)) {
          foundReturn = false
          returnIndent = -1
        }
        indentStack.push({ indent, type: 'condition' })
        // 检测恒真/恒假条件
        this.checkConstantCondition(trimmed, filePath, lineNum, issues)
        continue
      }

      // 检测 try/catch
      if (this.isTryCatchStart(trimmed)) {
        const withoutClosingBrace = trimmed.startsWith('}') ? trimmed.substring(1).trimStart() : trimmed

        // Python 的 except/finally 和 try 在同一缩进级别
        // 遇到 except/finally 时，先退出之前的 try/except 块
        if (/^\s*(catch|except|finally|handle)\b/.test(withoutClosingBrace)) {
          while (indentStack.length > 0 && indent <= indentStack[indentStack.length - 1].indent) {
            const popped = indentStack.pop()!
            if (popped.type === 'try' || popped.type === 'except') {
              foundReturn = false
              returnIndent = -1
            }
          }
          indentStack.push({ indent, type: 'except' })
        } else if (/^\s*(try)\b/.test(withoutClosingBrace)) {
          indentStack.push({ indent, type: 'try' })
        } else {
          indentStack.push({ indent, type: 'except' })
        }
        // try/except 块内的 return 不影响块之后的代码
        foundReturn = false
        returnIndent = -1
        continue
      }

      // 检测 return / throw 语句
      if (this.isReturnOrThrow(trimmed)) {
        // 在循环内不标记（循环后的代码仍可达）
        if (loopDepth > 0) continue
        // 在嵌套回调内不标记
        if (functionDepth > 1) continue
        // 在类体内但不在方法内不标记（类字段声明之间不是顺序执行）
        if (classDepth > 0 && functionDepth === 0) continue

        // AST 增强：如果当前行在函数边界之外，跳过
        // （模块级的 return/raise 在某些语言中是合法的守卫子句）
        if (functionBoundaries.size > 0 && functionDepth === 0) {
          let insideFunction = false
          for (const [start, end] of functionBoundaries) {
            if (lineNum >= start && lineNum <= end) {
              insideFunction = true
              break
            }
          }
          if (!insideFunction) continue
        }

        foundReturn = true
        returnIndent = indent

        // 检查是否是多行 return（括号/数组/对象未闭合）
        parenDepth = this.countExpressionDepth(normalizedLine)
        if (parenDepth > 0) {
          inMultilineReturn = true
        }

        continue
      }
    }

    return issues
  }

  // ==================== 辅助方法 ====================

  /** 判断是否是新的代码块开始（if/elif/else/try/except/for/while/def/class 等）
   *  这些结构不受前面 return 的影响，因为它们是独立的代码路径
   */
  private isNewBlockStart(trimmed: string): boolean {
    // 处理 } else { / } elif / } catch 等带前导 } 的情况
    const withoutClosingBrace = trimmed.startsWith('}') ? trimmed.substring(1).trimStart() : trimmed
    return /^\s*(if|elif|else|else\s+if)\b/.test(withoutClosingBrace)
      || /^\s*(try|except|catch|finally|handle)\b/.test(withoutClosingBrace)
      || /^\s*(for|while|do)\b/.test(withoutClosingBrace)
      || /^\s*(def|async\s+def)\b/.test(withoutClosingBrace)
      || /^\s*class\s+\w+/.test(withoutClosingBrace)
      || /^\s*(switch|case|match)\b/.test(withoutClosingBrace)
      || /^\s*(public|private|protected)\s+/.test(withoutClosingBrace)
      || /^\s*static\s+/.test(withoutClosingBrace)
      || /^\s*@\w+/.test(withoutClosingBrace)  // 装饰器/注解
      // 对象属性/方法定义 — 这些不是顺序执行的代码，return 不影响后续属性
      || /^\s*\w+\s*:\s*(async\s+)?(\([^)]*\)|\w+)\s*=>/.test(withoutClosingBrace)
      || /^\s*\w+\s*:\s*function\b/.test(withoutClosingBrace)
      || /^\s*["']\w+["']\s*:\s*/.test(withoutClosingBrace)
      || /^\s*\[/.test(withoutClosingBrace)  // 数组元素/计算属性
      // import / from 语句（模块级声明不受函数内 return 影响）
      || /^\s*(import|from)\s/.test(withoutClosingBrace)
      // Python 模块级 UPPER_CASE 常量（通常被其他文件导入使用）
      || /^\s*[A-Z_][A-Z_0-9]*\s*[=:]/.test(withoutClosingBrace)
      // Python 类型注解赋值 varName: Type = ...（模块级声明）
      || /^\s*\w+\s*:\s*(?:str|int|float|bool|list|dict|set|tuple|Optional|List|Dict|Set|Tuple|Union|Any|None|frozenset)\s*=/.test(withoutClosingBrace)
  }

  /** 判断是否是类定义开始 */
  private isClassStart(trimmed: string): boolean {
    return /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/.test(trimmed)
      || /^\s*(export\s+)?(default\s+)?class\s+\w+/.test(trimmed)
      // Python: class Xxx: / class Xxx(Base): / class Xxx(BaseModel):
      || /^\s*class\s+\w+/.test(trimmed)
  }

  /** 判断是否是函数定义开始 */
  private isFunctionStart(trimmed: string): boolean {
    // JS/TS: function, =>, async function
    // Python: def, async def
    // Go: func
    // Rust: fn
    // Java/Kotlin: 访问修饰符 + 返回类型 + 名称(
    return /^\s*(export\s+)?(default\s+)?(async\s+)?function\s/.test(trimmed)
      || /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\(/.test(trimmed)
      || /^\s*(public|private|protected|static|async)?\s*\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>/.test(trimmed)
      || /^\s*(async\s+)?\([^)]*\)\s*=>/.test(trimmed)
      || /^\s*(async\s+)?\w+\s*=>/.test(trimmed)
      || /^\s*(def|async\s+def)\s+\w+/.test(trimmed)
      || /^\s*func\s+\w+/.test(trimmed)
      || /^\s*fn\s+\w+/.test(trimmed)
      // Java/Kotlin 方法：需要访问修饰符或 static 开头，避免匹配 if/for/while 等控制流
      || /^\s*(public|private|protected)\s+(?:static\s+)?(?:async\s+)?(?:\*?\s*)?\w+\s*\([^)]*\)\s*[:{]/.test(trimmed)
      || /^\s*static\s+(?:async\s+)?(?:\*?\s*)?\w+\s*\([^)]*\)\s*[:{]/.test(trimmed)
  }

  /** 判断是否是循环开始 */
  private isLoopStart(trimmed: string): boolean {
    return /^\s*(for|while|do)\b/.test(trimmed)
      || /^\s*(for\s*\(.*\)\s*{|while\s*\(.*\)\s*{|do\s*{)/.test(trimmed)
      || /^\s*for\s+\w+\s+in\s/.test(trimmed)
      || /^\s*for\s+\w+\s+of\s/.test(trimmed)
  }

  /** 判断是否是条件块开始 */
  private isConditionStart(trimmed: string): boolean {
    // 处理 } else { / } else if (...) { / } elif 等带前导 } 的情况
    const withoutClosingBrace = trimmed.startsWith('}') ? trimmed.substring(1).trimStart() : trimmed
    return /^\s*(if|else\s+if|else|elif)\b/.test(withoutClosingBrace)
      || /^\s*switch\s*\(/.test(trimmed)
      || /^\s*case\s+/.test(trimmed)
      || /^\s*match\s+\w+/.test(trimmed)
  }

  /** 判断是否是 try/catch 开始 */
  private isTryCatchStart(trimmed: string): boolean {
    return /^\s*(try|catch|except|finally|handle)\b/.test(trimmed)
  }

  /** 判断是否是 return/throw 语句 */
  private isReturnOrThrow(trimmed: string): boolean {
    return /^\s*(return|throw|raise)\b/.test(trimmed)
  }

  private countExpressionDepth(line: string): number {
    return this.countChar(line, '(') - this.countChar(line, ')')
      + this.countChar(line, '[') - this.countChar(line, ']')
      + this.countChar(line, '{') - this.countChar(line, '}')
  }

  /** 统计字符出现次数 */
  private countChar(s: string, ch: string): number {
    let count = 0
    for (const c of s) {
      if (c === ch) count++
    }
    return count
  }

  /** 检测恒真/恒假条件 */
  private checkConstantCondition(trimmed: string, filePath: string, lineNum: number, issues: Issue[]): void {
    // 提取 if/elif/else if 后面的条件表达式
    const condMatch = trimmed.match(/^\s*(?:if|else\s+if|elif)\s*\((.+)\)\s*[{:]/)
      || trimmed.match(/^\s*(?:if|else\s+if|elif)\s+(.+?)\s*[{:]/)
    if (!condMatch) return

    const condition = condMatch[1].trim()

    // if(true) / if(True) / if(1) → 恒真
    if (/^(true|True|1)$/.test(condition)) {
      issues.push({
        rule: this.rule,
        severity: this.severity,
        category: this.category,
        file: filePath,
        line: lineNum,
        message: '条件永远为真，代码分支冗余',
        snippet: trimmed,
        suggestion: '移除永远为真的条件判断，或修正条件表达式',
      })
      return
    }

    // if(false) / if(False) / if(0) → 恒假
    if (/^(false|False|0)$/.test(condition)) {
      issues.push({
        rule: this.rule,
        severity: this.severity,
        category: this.category,
        file: filePath,
        line: lineNum,
        message: '条件永远为假，分支代码不可达',
        snippet: trimmed,
        suggestion: '移除永远为假的条件分支，或修正条件表达式',
      })
      return
    }

    // x === x / x == x 自比较（恒真）
    const selfCompareMatch = condition.match(/^(\w+)\s*(?:===|==)\s*\1$/)
    if (selfCompareMatch) {
      issues.push({
        rule: this.rule,
        severity: this.severity,
        category: this.category,
        file: filePath,
        line: lineNum,
        message: `自比较 "${selfCompareMatch[1]} === ${selfCompareMatch[1]}" 永远为真`,
        snippet: trimmed,
        suggestion: '检查是否应为不同的变量比较，或移除此冗余条件',
      })
    }
  }
}
