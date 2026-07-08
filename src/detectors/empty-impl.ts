/**
 * AIDE - 空实现函数检测器
 * 检测函数体为空、只有注释、或只有 return; 的函数
 */

import { isTestFile } from '../types/index.js'
import { getLineNumber, extractBlockBody } from '../core/utils.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'
import type { PythonASTResult } from '../core/python-ast-bridge.js'

export class EmptyImplDetector implements Detector {
  rule = 'empty-impl'
  category = 'ai-code' as const
  description = '检测空实现函数（空函数体、仅注释、仅 return;）'
  severity = 'high' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source: raw, language, filePath } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    // 在字符串字面量中可能出现 `function Foo() {}` 之类的示例代码，
    // 这些不是真实实现，需要在检测前剥离。
    const source = this.stripStringLiterals(raw)

    switch (language) {
      case 'typescript':
      case 'javascript':
        return this.detectJS(source, filePath)
      case 'python':
        return this.detectPython(source, filePath, ctx.pythonAst)
      case 'java':
        return this.detectJava(source, filePath)
      case 'go':
        return this.detectGo(source, filePath)
      case 'rust':
        return this.detectRust(source, filePath)
      default:
        return []
    }
  }

  /** 将字符串字面量中的字符替换为空格，保留长度以便行号、列号对齐 */
  private stripStringLiterals(code: string): string {
    // 状态机：处理单/双/反引号字符串和单行/块注释。
    let out = ''
    let i = 0
    const n = code.length
    while (i < n) {
      const c = code[i]
      const next = code[i + 1]
      // 行注释保留
      if (c === '/' && next === '/') {
        const end = code.indexOf('\n', i)
        const stop = end === -1 ? n : end
        out += code.slice(i, stop)
        i = stop
        continue
      }
      // 块注释保留
      if (c === '/' && next === '*') {
        const end = code.indexOf('*/', i + 2)
        const stop = end === -1 ? n : end + 2
        out += code.slice(i, stop)
        i = stop
        continue
      }
      if (c === '"' || c === '\'' || c === '`') {
        const quote = c
        out += quote
        i++
        while (i < n) {
          const ch = code[i]
          if (ch === '\\' && i + 1 < n) {
            // 跳过转义；保留换行计数
            out += code[i + 1] === '\n' ? '\n' : ' '
            out += ' '
            i += 2
            continue
          }
          if (ch === quote) {
            out += quote
            i++
            break
          }
          // 模板字符串内的 ${...} 暂保留原样，避免误吞代码
          if (quote === '`' && ch === '$' && code[i + 1] === '{') {
            let depth = 1
            out += '${'
            i += 2
            while (i < n && depth > 0) {
              if (code[i] === '{') depth++
              else if (code[i] === '}') depth--
              out += code[i]
              i++
              if (depth === 0) break
            }
            continue
          }
          out += ch === '\n' ? '\n' : ' '
          i++
        }
        continue
      }
      out += c
      i++
    }
    return out
  }

  private detectJS(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配 function name() { — 只匹配头部，函数体通过花括号深度计数提取
    const funcStartRegex = /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\w+(?:<[^>]+>)?)?\s*\{)/g
    // 匹配箭头函数 const name = () => { — 只匹配头部
    const arrowBlockStartRegex = /(?:(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\w+(?:<[^>]+>)?)?\s*=>\s*\{)/g

    let match: RegExpExecArray | null

    while ((match = funcStartRegex.exec(source)) !== null) {
      const name = match[1]
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)

      if (body === null) continue

      if (this.isJSConstructor(name)) continue
      if (this.isInterfaceDeclaration(source, match.index)) continue
      if (this.isNoopFunction(name)) continue

      if (this.isEmptyBodyJS(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name))
      }
      funcStartRegex.lastIndex = openBraceIndex + body.length + 2
    }

    while ((match = arrowBlockStartRegex.exec(source)) !== null) {
      const name = match[1]
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)

      if (body === null) continue
      if (this.isNoopFunction(name)) continue

      if (this.isEmptyBodyJS(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name))
      }
      arrowBlockStartRegex.lastIndex = openBraceIndex + body.length + 2
    }

    return issues
  }

  private detectPython(source: string, filePath: string, pythonAst?: PythonASTResult): Issue[] {
    const issues: Issue[] = []

    // Python AST 桥接路径：使用 CPython 解析，100% 准确
    if (pythonAst) {
      for (const func of pythonAst.functions) {
        if (this.isPythonInitOrConstructor(func.name)) continue
        // 跳过抽象方法（@abstractmethod 装饰的函数本就只有 pass）
        if (this.isPythonAbstractMethod(source, func.startLine)) continue
        // 跳过 Protocol/ABC/ABCMeta 类中的方法
        if (this.isPythonAbstractClass(source, func.startLine)) continue
        // 跳过懒加载/桩函数模式（_ensure_*, _get_*, on_* 等）
        if (this.isLazyOrStubPattern(func.name)) continue
        // 跳过 @property / @field_validator 等装饰的方法
        if (this.isPythonPropertyOrValidator(source, func.startLine)) continue
        // 跳过测试函数（test_* 开头的函数有完整的测试逻辑，不应视为空实现）
        if (func.name.startsWith('test_')) continue
        // 跳过 dunder 方法（__repr__/__str__/__len__/__eq__ 等通常只有简单 return）
        if (/^__\w+__$/.test(func.name)) continue
        // 跳过 @pytest.fixture / @fixture 装饰的测试夹具
        if (func.decorators.includes('fixture')) continue
        if (!func.hasBody) {
          issues.push({
            rule: this.rule,
            severity: 'high',
            category: 'ai-code',
            file: filePath,
            line: func.startLine,
            message: `空实现函数 "${func.name}"`,
            snippet: `${func.name}()`,
            suggestion: `请为函数 "${func.name}" 添加实际实现，或使用 raise NotImplementedError 标记为待实现`,
          })
        }
      }
      return issues
    }

    // 回退路径：正则解析（无 python3 环境时使用）
    const funcRegex = /^(\s*)def\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^=]+)?\s*:\s*\n((?:\1\s+.*\n)*)/gm

    let match: RegExpExecArray | null

    while ((match = funcRegex.exec(source)) !== null) {
      const name = match[2]
      const body = match[3]
      const defLineNum = getLineNumber(source, match.index!)

      if (this.isPythonInitOrConstructor(name)) continue
      // 跳过抽象方法
      if (this.isPythonAbstractMethod(source, defLineNum)) continue
      // 跳过 Protocol/ABC/ABCMeta 类中的方法（抽象方法本就只有 pass）
      if (this.isPythonAbstractClass(source, defLineNum)) continue
      // 跳过懒加载/桩函数模式
      if (this.isLazyOrStubPattern(name)) continue
      // 跳过 @property / @field_validator 等装饰的方法
      if (this.isPythonPropertyOrValidator(source, defLineNum)) continue
      // 跳过测试函数（test_* 开头的函数有完整的测试逻辑，不应视为空实现）
      if (name.startsWith('test_')) continue
      // 跳过 dunder 方法（__repr__/__str__/__len__/__eq__ 等通常只有简单 return）
      if (/^__\w+__$/.test(name)) continue
      // 跳过 @pytest.fixture / @fixture 装饰的测试夹具
      if (this.isPytestFixture(source, defLineNum)) continue

      if (this.isEmptyBodyPython(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name))
      }
    }

    return issues
  }

  /** 检查 JS/TS 函数体是否为空实现 */
  private isEmptyBodyJS(body: string): boolean {
    // 去掉注释后检查
    const noComments = body
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()

    // 空函数体
    if (noComments === '') return true

    // 只有 return;
    if (/^\s*return\s*;\s*$/.test(noComments)) return true

    return false
  }

  /** 检查 Python 函数体是否为空实现 */
  private isEmptyBodyPython(body: string): boolean {
    const lines = body.split('\n').filter(l => l.trim() !== '')
    if (lines.length === 0) return true

    // 只有注释
    const noComments = lines.filter(l => !l.trim().startsWith('#'))
    if (noComments.length === 0) return true

    // 只有 pass / ... / return
    const meaningful = noComments.map(l => l.trim())
    if (meaningful.length === 1) {
      const line = meaningful[0]
      if (line === 'pass' || line === '...' || line === 'return') return true
      // raise NotImplementedError 是合法的"待实现"标记，不算空实现
      // 匹配 raise NotImplementedError 和 raise NotImplementedError("msg")
      if (/^\s*raise\s+NotImplementedError\b/i.test(line)) return false
    }

    return false
  }

  /** 是否为 JS/TS 构造函数 */
  private isJSConstructor(name: string): boolean {
    return name === 'constructor'
  }

  /** 是否为接口声明（interface 中无实现的方法） */
  private isInterfaceDeclaration(source: string, funcIndex: number): boolean {
    const before = source.substring(Math.max(0, funcIndex - 500), funcIndex)
    // 如果在 interface 块内，则跳过
    const lastInterface = before.lastIndexOf('interface ')
    const lastBrace = before.lastIndexOf('}')
    if (lastInterface !== -1 && lastBrace < lastInterface) return true
    // abstract 方法
    if (/\babstract\s+$/.test(before)) return true
    return false
  }

  /** 是否为 Python __init__ 或 __new__ */
  private isPythonInitOrConstructor(name: string): boolean {
    return name === '__init__' || name === '__new__' || name === '__post_init__'
  }

  /** 是否为 JS/TS noop 函数（有意设计的空操作） */
  private isNoopFunction(name: string): boolean {
    return /^(noop|noop_|noopFn|emptyFn|emptyFunction|noOp|no_op|placeholder)$/i.test(name)
  }

  /** 是否为 Python @property / @field_validator 等装饰的方法（非空实现） */
  private isPythonPropertyOrValidator(source: string, defLineNum: number): boolean {
    const lines = source.split('\n')
    // 检查 def 行之前的非空行是否有相关装饰器
    for (let i = defLineNum - 2; i >= 0; i--) {
      const trimmed = lines[i].trim()
      if (trimmed === '') continue
      // @property
      if (/^@property\b/.test(trimmed)) return true
      // @xxx.setter / @xxx.deleter
      if (/^@\w+\.(?:setter|deleter)\b/.test(trimmed)) return true
      // @cached_property / @functools.cached_property
      if (/^@(?:functools\.)?cached_property\b/.test(trimmed)) return true
      // @field_validator / @validator / @field_serializer / @computed_field
      if (/^@(?:field_validator|validator|field_serializer|computed_field)\b/.test(trimmed)) return true
      // @classmethod / @staticmethod
      if (/^@(?:classmethod|staticmethod)\b/.test(trimmed)) return true
      // 遇到其他装饰器继续向上查找
      if (/^@/.test(trimmed)) continue
      // 遇到非装饰器、非空行，停止
      break
    }
    return false
  }

  /** 是否为 @pytest.fixture 或 @fixture 装饰的函数 */
  private isPytestFixture(source: string, defLineNum: number): boolean {
    const lines = source.split('\n')
    // 检查 def 行之前的非空行是否有 @pytest.fixture 或 @fixture
    for (let i = defLineNum - 2; i >= 0; i--) {
      const trimmed = lines[i].trim()
      if (trimmed === '') continue
      if (/^@(?:pytest\.)?fixture\b/.test(trimmed)) return true
      // 遇到其他装饰器继续向上查找
      if (/^@/.test(trimmed)) continue
      // 遇到非装饰器、非空行，停止
      break
    }
    return false
  }

  /** 是否为 Python @abstractmethod 装饰的方法 */
  private isPythonAbstractMethod(source: string, defLineNum: number): boolean {
    const lines = source.split('\n')
    // 检查 def 行之前的非空行是否有 @abstractmethod
    for (let i = defLineNum - 2; i >= 0; i--) {
      const trimmed = lines[i].trim()
      if (trimmed === '') continue
      if (/^@abstractmethod\b/.test(trimmed)) return true
      // 遇到其他装饰器继续向上查找
      if (/^@/.test(trimmed)) continue
      // 遇到非装饰器、非空行，停止
      break
    }
    return false
  }

  /** 是否为 Python 抽象基类（Protocol/ABC/ABCMeta）中的方法 */
  private isPythonAbstractClass(source: string, defLineNum: number): boolean {
    const lines = source.split('\n')
    const defLine = lines[defLineNum - 1]
    const defIndent = defLine ? defLine.length - defLine.trimStart().length : 0

    // 向上搜索缩进更小的 class 定义
    for (let i = defLineNum - 2; i >= 0; i--) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue

      const lineIndent = line.length - line.trimStart().length
      if (lineIndent < defIndent) {
        const classMatch = /^class\s+\w+\s*\(([^)]*)\)/.exec(trimmed)
        if (classMatch) {
          const bases = classMatch[1]
          return /\b(?:Protocol|ABC|ABCMeta)\b/.test(bases)
        }
      }
    }
    return false
  }

  /**
   * 是否为懒加载/桩函数命名模式。
   * 这些函数名暗示它们是延迟初始化、工厂方法或事件回调桩，
   * 空实现是设计意图，不是 AI 生成代码的缺陷。
   *
   * 通用模式（跨所有 Python 项目）：
   * - _ensure_* : 懒加载初始化（SQLAlchemy/Redis/Django 标准）
   * - _get_*    : 延迟绑定/工厂方法（OOP 标准模式）
   * - _create_* : 工厂方法（设计模式）
   * - on_*      : 事件回调桩（GUI 框架标准）
   * - _on_*     : 受保护的事件回调桩
   */
  private isLazyOrStubPattern(name: string): boolean {
    // 懒加载初始化模式
    if (/^_ensure_/.test(name)) return true
    // 延迟绑定/工厂方法模式
    if (/^_get_/.test(name)) return true
    // 工厂方法模式
    if (/^_create_/.test(name)) return true
    // 事件回调桩模式
    if (/^on_/.test(name)) return true
    if (/^_on_/.test(name)) return true
    // 平台桩函数（create_tray, create_window 等）
    if (/^create_/.test(name)) return true
    return false
  }

  /** 检测 Java 空实现方法 */
  private detectJava(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []
    // 匹配 Java 方法头部
    const methodStartRegex = /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:abstract\s+)?(?:\w+(?:<[^>]+>)?(?:\[\])?)\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g

    let match: RegExpExecArray | null
    while ((match = methodStartRegex.exec(source)) !== null) {
      const name = match[1]
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)
      if (body === null) continue

      // 跳过构造函数
      if (this.isJavaConstructor(source, match.index, name)) continue
      // 跳过 abstract 方法（检查最后 5 行，避免 abstract 和方法声明不在同一行时误报）
      const before = source.substring(Math.max(0, match.index - 200), match.index)
      const lastFiveLines = before.split('\n').slice(-5).join('\n')
      if (/\babstract\b/.test(lastFiveLines)) continue
      // 跳过 default 方法（接口默认方法，Java 8+）
      if (/\bdefault\b/.test(lastFiveLines)) continue
      // 跳过 @Override 方法
      if (/@Override/.test(lastFiveLines)) continue

      if (this.isEmptyBodyJava(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name))
      }
      methodStartRegex.lastIndex = openBraceIndex + body.length + 2
    }
    return issues
  }

  /** 检查 Java 方法体是否为空实现 */
  private isEmptyBodyJava(body: string): boolean {
    const noComments = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (noComments === '') return true
    if (/^\s*return\s*;\s*$/.test(noComments)) return true
    // 只有 return null; 的 void 返回类型也算空实现
    if (/^\s*return\s+null\s*;\s*$/.test(noComments)) return true
    return false
  }

  /** 是否为 Java 构造函数 */
  private isJavaConstructor(source: string, index: number, name: string): boolean {
    const before = source.substring(Math.max(0, index - 500), index)
    const classMatch = /class\s+(\w+)/.exec(before)
    return classMatch ? classMatch[1] === name : false
  }

  /** 检测 Go 空实现函数 */
  private detectGo(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []
    // 匹配 Go 函数头部
    const funcStartRegex = /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\([^)]*\)\s*(?:\([^)]*\))?\s*\{/g

    let match: RegExpExecArray | null
    while ((match = funcStartRegex.exec(source)) !== null) {
      const name = match[1]
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)
      if (body === null) continue

      // 跳过 init 和 main
      if (name === 'init' || name === 'main') continue

      if (this.isEmptyBodyGo(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name))
      }
      funcStartRegex.lastIndex = openBraceIndex + body.length + 2
    }
    return issues
  }

  /** 检查 Go 函数体是否为空实现 */
  private isEmptyBodyGo(body: string): boolean {
    const noComments = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (noComments === '') return true
    // 只有 return 语句
    if (/^\s*return\s*$/.test(noComments)) return true
    // 只有 return nil / return 0 / return false / return ""
    if (/^\s*return\s+(?:nil|0|false|"")\s*$/.test(noComments)) return true
    return false
  }

  /** 检测 Rust 空实现函数 */
  private detectRust(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []
    // 匹配 Rust 函数头部
    const funcStartRegex = /(?:pub\s+)?fn\s+(\w+)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?:->\s*[^{]+)?\s*\{/g

    let match: RegExpExecArray | null
    while ((match = funcStartRegex.exec(source)) !== null) {
      const name = match[1]
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)
      if (body === null) continue

      // 跳过 new / default
      if (name === 'new' || name === 'default') continue
      // 跳过测试函数
      const before = source.substring(Math.max(0, match.index - 100), match.index)
      if (/#\[test\]/.test(before)) continue

      if (this.isEmptyBodyRust(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name))
      }
      funcStartRegex.lastIndex = openBraceIndex + body.length + 2
    }
    return issues
  }

  /** 检查 Rust 函数体是否为空实现 */
  private isEmptyBodyRust(body: string): boolean {
    const noComments = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (noComments === '') return true
    // 只有 return; 或 return ();
    if (/^\s*return\s*(?:\(\))?\s*;\s*$/.test(noComments)) return true
    return false
  }

  private createIssue(filePath: string, source: string, index: number, name: string): Issue {
    return {
      rule: this.rule,
      severity: 'high',
      category: 'ai-code',
      file: filePath,
      line: getLineNumber(source, index),
      message: `空实现函数 "${name}"`,
      snippet: `${name}()`,
      suggestion: `请为函数 "${name}" 添加实际实现，或使用 throw new Error('Not implemented') 标记为待实现`,
    }
  }
}
