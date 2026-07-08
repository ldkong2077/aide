/**
 * AIDE - Stub 函数检测器
 * 检测函数体只有 return true/false/null/[]{}/{} 的 Stub 函数
 */

import { isTestFile } from '../types/index.js'
import { getLineNumber, extractBlockBody } from '../core/utils.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'
import type { PythonASTResult } from '../core/python-ast-bridge.js'

/** 布尔前缀函数名（这些返回 true/false 可能是合理的） */
const BOOLEAN_PREFIXES = /^(is|has|can|should|will|would|was|were|did|does|could|may|might|shall|must|needs|supports|allows|requires|enables|contains|includes|equals|matches|check|verify|validate|assert|confirm|determine|resolve|ensure)/i

/** Factory/Creator 前缀函数名（这些返回默认值是合理的设计模式） */
const FACTORY_PREFIXES = /^(create|make|build|new|from|to|as|convert|parse|encode|decode|initialize|setup|configure|provide|supply|produce|generate)/i

export class StubFunctionDetector implements Detector {
  rule = 'stub-function'
  category = 'ai-code' as const
  description = '检测函数体只有 return true/false/null/[]{}/{} 的 Stub 函数'
  severity = 'high' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

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

  private detectJS(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配 function name() { — 只匹配头部，函数体通过花括号深度计数提取
    const funcStartRegex = /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\w+(?:<[^>]+>)?)?\s*\{)/g
    // 匹配箭头函数 const/let/var name = () => <stub-value>（表达式体）
    const arrowExprRegex = /(?:(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\w+(?:<[^>]+>)?)?\s*=>\s*([^\n;]+))/g
    // 匹配箭头函数 const/let/var name = () => { ... }（块体）
    const arrowBlockStartRegex = /(?:(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\w+(?:<[^>]+>)?)?\s*=>\s*\{)/g

    let match: RegExpExecArray | null

    while ((match = funcStartRegex.exec(source)) !== null) {
      const name = match[1]
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)

      if (body === null) continue

      if (this.isBooleanPrefix(name)) continue
      if (this.isFactoryPrefix(name)) continue
      if (this.isGetterOrOverride(source, match.index)) continue
      if (this.isReactComponent(name, body)) continue
      if (this.isTypeGuard(name, source, match.index)) continue

      if (this.isStubBodyJS(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name, body.trim()))
      }
      funcStartRegex.lastIndex = openBraceIndex + body.length + 2
    }

    while ((match = arrowExprRegex.exec(source)) !== null) {
      const name = match[1]
      const body = match[2].trim()

      if (this.isBooleanPrefix(name)) continue
      if (this.isFactoryPrefix(name)) continue
      if (this.isReactComponent(name, body)) continue

      if (this.isStubBodyJS(body) || this.isStubArrowBodyJS(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name, body))
      }
    }

    while ((match = arrowBlockStartRegex.exec(source)) !== null) {
      const name = match[1]
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)

      if (body === null) continue
      if (this.isBooleanPrefix(name)) continue
      if (this.isFactoryPrefix(name)) continue
      if (this.isReactComponent(name, body)) continue

      if (this.isStubBodyJS(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name, body.trim()))
      }
      arrowBlockStartRegex.lastIndex = openBraceIndex + body.length + 2
    }

    return issues
  }

  private detectPython(source: string, filePath: string, pythonAst?: PythonASTResult): Issue[] {
    const issues: Issue[] = []
    const lines = source.split('\n')

    // Python AST 桥接路径：使用 CPython 解析的精确函数边界
    if (pythonAst) {
      for (const func of pythonAst.functions) {
        if (this.isBooleanPrefix(func.name)) continue
        if (this.isFactoryPrefix(func.name)) continue
        if (this.isPythonDunder(func.name)) continue

        // Stub 函数只有一条语句（return <value>）
        if (func.bodyStatementCount !== 1) continue

        // 提取第一条 body 行
        const bodyLineIdx = func.startLine  // def 行
        for (let i = func.startLine; i <= func.endLine && i <= lines.length; i++) {
          const trimmed = lines[i - 1].trim()
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('"""') && !trimmed.startsWith("'''") && !trimmed.startsWith('def ')) {
            if (this.isStubBodyPython(trimmed)) {
              issues.push({
                rule: this.rule,
                severity: 'high',
                category: 'ai-code',
                file: filePath,
                line: func.startLine,
                message: `Stub 函数 "${func.name}" 只返回简单值: ${trimmed}`,
                snippet: trimmed,
                suggestion: `请为函数 "${func.name}" 添加实际实现逻辑，而非返回占位值`,
              })
            }
            break
          }
        }
      }
      return issues
    }

    // 回退路径：正则解析（无 python3 环境时使用）
    const funcRegex = /^(\s*)def\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^=]+)?\s*:\s*\n(\1\s+.*)/gm

    let match: RegExpExecArray | null

    while ((match = funcRegex.exec(source)) !== null) {
      const name = match[2]
      const body = match[3].trim()

      if (this.isBooleanPrefix(name)) continue
      if (this.isFactoryPrefix(name)) continue
      if (this.isPythonDunder(name)) continue

      if (this.isStubBodyPython(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name, body))
      }
    }

    return issues
  }

  /** 检查 JS/TS 函数体是否为 stub */
  private isStubBodyJS(body: string): boolean {
    const trimmed = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    // return true / false / null / undefined / [] / {}
    return /^\s*return\s+(?:true|false|null|undefined|\[\s*\]|\{\s*\})\s*;?\s*$/.test(trimmed)
  }

  /** 检查箭头函数无块体的返回值是否为 stub */
  private isStubArrowBodyJS(body: string): boolean {
    const trimmed = body.trim()
    // 箭头函数无块体: () => true / () => false / () => null / () => undefined / () => [] / () => ({})
    return /^(?:true|false|null|undefined|\[\s*\]|\(\s*\{\s*\}\s*\))$/.test(trimmed)
  }

  /** 检查 Java 方法体是否为 stub */
  private isStubBodyJava(body: string): boolean {
    const noComments = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    // return true / false / null / Collections.emptyList() / new ArrayList<>() / new HashMap<>()
    return /^\s*return\s+(?:true|false|null|Collections\.emptyList\(\)|Collections\.emptyMap\(\)|Collections\.emptySet\(\)|new\s+ArrayList(?:<.*?>)?\(\)|new\s+HashMap(?:<.*?>)?\(\)|new\s+HashSet(?:<.*?>)?\(\)|Optional\.empty\(\))\s*;?\s*$/.test(noComments)
  }

  /** 检查是否为 Java 构造函数 */
  private isJavaConstructor(source: string, index: number, name: string): boolean {
    // 构造函数没有返回类型，检查 class 名称
    const before = source.substring(Math.max(0, index - 500), index)
    const classMatch = /class\s+(\w+)/.exec(before)
    return classMatch ? classMatch[1] === name : false
  }

  private detectJava(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []
    // 匹配 Java 方法头部
    const methodStartRegex = /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:\w+(?:<[^>]+>)?(?:\[\])?)\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g

    let match: RegExpExecArray | null
    while ((match = methodStartRegex.exec(source)) !== null) {
      const name = match[1]
      const openBraceIndex = match.index + match[0].length - 1
      const body = extractBlockBody(source, openBraceIndex)
      if (body === null) continue

      // 跳过构造函数
      if (this.isJavaConstructor(source, match.index, name)) continue
      // 跳过布尔前缀方法
      if (this.isBooleanPrefix(name)) continue
      // 跳过 Factory 前缀方法
      if (this.isFactoryPrefix(name)) continue
      // 跳过 override 方法
      const before = source.substring(Math.max(0, match.index - 200), match.index)
      if (/@Override/.test(before)) continue

      if (this.isStubBodyJava(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name, body.trim()))
      }
      methodStartRegex.lastIndex = openBraceIndex + body.length + 2
    }
    return issues
  }

  /** 检查 Go 函数体是否为 stub */
  private isStubBodyGo(body: string): boolean {
    const noComments = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    // return true / false / nil / "" / 0 / struct{}{}
    return /^\s*return\s+(?:true|false|nil|""|0|struct\s*\{\s*\})\s*$/.test(noComments)
  }

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

      if (this.isBooleanPrefix(name)) continue
      if (this.isFactoryPrefix(name)) continue
      // 跳过 init 函数
      if (name === 'init' || name === 'main') continue

      if (this.isStubBodyGo(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name, body.trim()))
      }
      funcStartRegex.lastIndex = openBraceIndex + body.length + 2
    }
    return issues
  }

  /** 检查 Rust 函数体是否为 stub */
  private isStubBodyRust(body: string): boolean {
    const noComments = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    // return true / false / None / "" / 0 / String::new() / vec![] / Default::default()
    // 同时处理无 return 的表达式体: true, false, None
    return /^\s*(?:return\s+)?(?:true|false|None|""|0|String::new\(\)|vec!\s*\[\s*\]|Default::default\(\))\s*;?\s*$/.test(noComments)
  }

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

      if (this.isBooleanPrefix(name)) continue
      if (this.isFactoryPrefix(name)) continue
      // 跳过 new / default 函数
      if (name === 'new' || name === 'default') continue
      // 跳过测试函数
      if (filePath.endsWith('.rs') && /#\[test\]/.test(source.substring(Math.max(0, match.index - 100), match.index))) continue

      if (this.isStubBodyRust(body)) {
        issues.push(this.createIssue(filePath, source, match.index, name, body.trim()))
      }
      funcStartRegex.lastIndex = openBraceIndex + body.length + 2
    }
    return issues
  }

  /** 检查 Python 函数体是否为 stub */
  private isStubBodyPython(body: string): boolean {
    const trimmed = body.replace(/#.*$/gm, '').trim()
    return /^\s*return\s+(?:True|False|None|\[\s*\]|\{\s*\})\s*$/.test(trimmed)
  }

  /** 函数名是否以布尔前缀开头 */
  private isBooleanPrefix(name: string): boolean {
    return BOOLEAN_PREFIXES.test(name)
  }

  /** 函数名是否以 Factory/Creator 前缀开头 */
  private isFactoryPrefix(name: string): boolean {
    return FACTORY_PREFIXES.test(name)
  }

  /** 是否为 React 组件（首字母大写 + 返回 JSX/Null） */
  private isReactComponent(name: string, body: string): boolean {
    return /^[A-Z]/.test(name) && /return\s*(?:<|null|undefined)/.test(body)
  }

  /** 是否为类型守卫函数（返回 boolean 类型） */
  private isTypeGuard(name: string, source: string, funcIndex: number): boolean {
    const afterFunc = source.substring(funcIndex, funcIndex + 300)
    return /:\s*(?:boolean|Boolean)\b/.test(afterFunc) && /^(is|has|check|verify)/.test(name)
  }

  /** 是否为 getter/setter 或 override 方法 */
  private isGetterOrOverride(source: string, funcIndex: number): boolean {
    const before = source.substring(Math.max(0, funcIndex - 200), funcIndex)
    return /\bget\s+\w+\s*\(/.test(before) || /\bset\s+\w+\s*\(/.test(before) || /\boverride\b/.test(before)
  }

  /** 是否为 Python dunder 方法 */
  private isPythonDunder(name: string): boolean {
    return name.startsWith('__') && name.endsWith('__')
  }

  private createIssue(filePath: string, source: string, index: number, name: string, body: string): Issue {
    return {
      rule: this.rule,
      severity: 'high',
      category: 'ai-code',
      file: filePath,
      line: getLineNumber(source, index),
      message: `Stub 函数 "${name}" 只返回简单值: ${body.trim()}`,
      snippet: body.trim(),
      suggestion: `请为函数 "${name}" 添加实际实现逻辑，而非返回占位值`,
    }
  }
}
