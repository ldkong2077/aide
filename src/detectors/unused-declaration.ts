/**
 * AIDE - 未使用声明检测器
 * 检测未使用的变量和导入
 *
 * 支持 Python / JS/TS / Go 三种语言的导入和变量声明检查
 * 跳过下划线开头的变量（约定为有意不使用）
 */

import { isTestFile } from '../types/index.js'
import { getLineNumber, escapeRegex } from '../core/utils.js'
import type { Detector, DetectorContext, Issue, ProjectSymbolIndex, Confidence } from '../types/index.js'
import type { CodeGraph } from '../core/code-graph.js'
import { buildSymbolTable, isReferenced, isExported, stripComments, stripStrings } from '../core/type-inferencer.js'
import type { ParseResult } from '../core/ast-parser.js'

interface Declaration {
  name: string
  line: number
  snippet: string
  /** 模块级函数标记（Python def），跨文件引用不确定时低置信度 */
  _moduleLevelFunc?: boolean
}

/** 明显的占位符变量名 — 测试数据或示例代码，不是真实声明 */
const PLACEHOLDER_NAME_REGEX = /^[xyz]{2,}$|^_{3,}$|^TODO$|^FIXME$|^placeholder$|^example$|^foobar?$/i

export class UnusedDeclarationDetector implements Detector {
  rule = 'unused-declaration'
  category = 'quality' as const
  description = '检测未使用的变量和导入'
  severity = 'low' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    // 当 AST 可用时，使用符号表增强检测
    const symbolTable = ctx.ast
      ? buildSymbolTable(ctx.ast as ParseResult, source, language)
      : null

    switch (language) {
      case 'python': return this.checkPython(source, filePath, symbolTable, ctx.projectSymbols, ctx.codeGraph)
      case 'typescript':
      case 'javascript': return this.checkJS(source, filePath, symbolTable, ctx.projectSymbols, ctx.codeGraph)
      case 'go': return this.checkGo(source, filePath, symbolTable, ctx.projectSymbols, ctx.codeGraph)
      case 'java': return this.checkJava(source, filePath, symbolTable, ctx.projectSymbols, ctx.codeGraph)
      case 'rust': return this.checkRust(source, filePath, symbolTable, ctx.projectSymbols, ctx.codeGraph)
      default: return []
    }
  }

  // ==================== Python ====================

  private checkPython(source: string, filePath: string, symbolTable: import('../core/type-inferencer.js').SymbolTable | null, projectSymbols?: ProjectSymbolIndex, codeGraph?: CodeGraph): Issue[] {
    // 跳过 alembic 迁移文件——其中的 down_revision/branch_labels/depends_on 等是框架反射变量
    if (/alembic[\\\/]versions[\\\/]/.test(filePath)) return []

    const declarations: Declaration[] = []

    // import xxx
    const importRegex = /^import\s+(\w+)/gm
    let match: RegExpExecArray | null
    while ((match = importRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_')) continue
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    // from xxx import yyy (可能多个: from xxx import a, b, c)
    const fromImportRegex = /^from\s+(\S+)\s+import\s+(.+)/gm
    while ((match = fromImportRegex.exec(source)) !== null) {
      const module = match[1]
      // __future__ 导入是类型提示特性，不算"未使用"
      if (module === '__future__') continue
      const names = match[2].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
      const line = getLineNumber(source, match.index)
      for (const name of names) {
        if (!name || name.startsWith('_') || name === '*') continue
        // 过滤非合法标识符（如 from .xxx import ( 中的括号）
        if (!/^[a-zA-Z_]\w*$/.test(name)) continue
        declarations.push({ name, line, snippet: match[0].trim() })
      }
    }

    // 变量赋值: xxx = ...
    const varRegex = /^(\w+)[ \t]*=/gm
    while ((match = varRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_')) continue
      // 排除 Python 关键字和常见内置
      if (this.isPythonKeyword(name)) continue

      // 全大写常量（UPPER_CASE 约定）是模块公共 API，
      // 通常被其他文件 import 使用，单文件频率统计无法检测，跳过
      if (/^[A-Z][A-Z_0-9]+$/.test(name)) continue

      // __all__ 中引用的符号是公共 API，即使本文件不使用也应跳过
      if (this.isReferencedByAll(source, name)) continue

      // TYPE_CHECKING 块中的导入仅用于类型检查，跳过
      if (this.isInTypeCheckingBlock(source, getLineNumber(source, match.index))) continue

      // Python 模块级函数（def xxx()）通常被其他文件动态导入，
      // 但此正则只匹配变量赋值，函数定义由下方单独处理
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    // 函数定义: def xxx(...)
    // 模块级 def（非类内方法）很可能是被其他文件 from xxx import yyy 使用，
    // 在缺少跨文件引用证据时，不应高置信度报告为"未使用"
    const funcDefRegex = /^def\s+(\w+)\s*\(/gm
    const classBodyRanges = this.getClassBodyRanges(source)
    while ((match = funcDefRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_')) continue
      if (name.startsWith('__') && name.endsWith('__')) continue  // dunder

      const funcLine = getLineNumber(source, match.index)

      // 判断是否在类体内（类方法由其他机制处理）
      const inClass = classBodyRanges.some(([start, end]) => funcLine >= start && funcLine <= end)
      if (inClass) continue  // 类方法跳过，由其他检测器处理

      // __all__ 中引用的函数是公共 API，跳过
      if (this.isReferencedByAll(source, name)) continue

      // 模块级函数：只做低置信度报告，避免跨文件引用误报
      declarations.push({
        name,
        line: funcLine,
        snippet: match[0].trim(),
        _moduleLevelFunc: true,  // 标记为模块级函数
      } as any)
    }

    return this.findUnused(declarations, source, filePath, symbolTable, projectSymbols, codeGraph)
  }

  /** 检查符号是否在 __all__ 中被引用 */
  private isReferencedByAll(source: string, name: string): boolean {
    const allRegex = /__all__\s*=\s*\[[\s\S]*?\]/g
    const allMatch = allRegex.exec(source)
    if (allMatch) {
      return allMatch[0].includes(`'${name}'`) || allMatch[0].includes(`"${name}"`)
    }
    return false
  }

  /** 检查行是否在 TYPE_CHECKING 块中 */
  private isInTypeCheckingBlock(source: string, line: number): boolean {
    const lines = source.split('\n')
    // 向上搜索 if TYPE_CHECKING:
    for (let i = line - 2; i >= 0; i--) {
      if (/^if\s+TYPE_CHECKING\s*:/.test(lines[i].trim())) return true
      if (lines[i].trim() !== '' && !lines[i].trim().startsWith('#')) break
    }
    return false
  }

  // ==================== JavaScript / TypeScript ====================

  private checkJS(source: string, filePath: string, symbolTable: import('../core/type-inferencer.js').SymbolTable | null, projectSymbols?: ProjectSymbolIndex, codeGraph?: CodeGraph): Issue[] {
    const declarations: Declaration[] = []

    // import { xxx } from '...'
    // import { xxx as yyy } from '...'
    // import type { xxx } from '...' — TypeScript type-only import，跳过
    const namedImportRegex = /import\s*(?:type\s+)?\{([^}]+)\}\s*from\s+['"][^'"]+['"]/g
    let match: RegExpExecArray | null
    while ((match = namedImportRegex.exec(source)) !== null) {
      // 跳过 type-only import（如 import type { Foo } from '...'）
      if (/import\s+type\s+/.test(match[0])) continue

      const bindings = match[1].split(',').map(s => {
        const parts = s.trim().split(/\s+as\s+/)
        return parts.length > 1 ? parts[1]!.trim() : parts[0]!.trim()
      })
      const line = getLineNumber(source, match.index)
      for (const name of bindings) {
        if (!name || name.startsWith('_')) continue
        declarations.push({ name, line, snippet: match[0].trim() })
      }
    }

    // import xxx from '...'
    const defaultImportRegex = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g
    while ((match = defaultImportRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_')) continue
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    // import * as xxx from '...'
    const namespaceImportRegex = /import\s+\*\s+as\s+(\w+)\s+from\s+['"][^'"]+['"]/g
    while ((match = namespaceImportRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_')) continue
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    // const/let/var xxx = ...
    // 逐行扫描，避免 `as const\n  description =` 这类跨行误匹配；
    // 同时跳过 `export const ...`（导出符号不能仅凭本文件判断是否“未使用”）。
    const lines = source.split('\n')
    const varDeclRegex = /^\s*(?:const|let|var)\s+(\w+)\s*=/
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]
      // 显式跳过 export 行（export const/function/class 都是导出符号）
      if (/^\s*export\b/.test(lineText)) continue
      // 跳过解构声明（容易误报）
      if (/^\s*(?:const|let|var)\s*[\[{]/.test(lineText)) continue
      const m2 = varDeclRegex.exec(lineText)
      if (m2) {
        const name = m2[1]
        if (name && !name.startsWith('_')) {
          declarations.push({
            name,
            line: i + 1,
            snippet: m2[0].trim(),
          })
        }
      }
    }

    return this.findUnused(declarations, source, filePath, symbolTable, projectSymbols, codeGraph)
  }

  // ==================== Go ====================

  private checkGo(source: string, filePath: string, symbolTable: import('../core/type-inferencer.js').SymbolTable | null, projectSymbols?: ProjectSymbolIndex, codeGraph?: CodeGraph): Issue[] {
    const declarations: Declaration[] = []

    // import 块中的包名
    const importBlockRegex = /import\s*\(([\s\S]*?)\)/g
    let match: RegExpExecArray | null
    while ((match = importBlockRegex.exec(source)) !== null) {
      const blockContent = match[1]
      // xxx "pkg/path" — 取别名
      const aliasRegex = /(\w+)\s+"[^"]+"/g
      let aliasMatch: RegExpExecArray | null
      while ((aliasMatch = aliasRegex.exec(blockContent)) !== null) {
        const alias = aliasMatch[1]
        if (alias === '_' || alias === '.') continue // _ 和 . 是 Go 的特殊导入
        declarations.push({
          name: alias,
          line: getLineNumber(source, match.index + aliasMatch.index),
          snippet: aliasMatch[0].trim(),
        })
      }

      // 无别名: "pkg/path" — 取路径最后一段
      const pkgRegex = /"([^"]+)"/g
      let pkgMatch: RegExpExecArray | null
      while ((pkgMatch = pkgRegex.exec(blockContent)) !== null) {
        const pkgPath = pkgMatch[1]
        const pkgName = pkgPath.split('/').pop()!
        // 如果已有别名声明则跳过
        const aliasCheckRegex = /\w+\s+"(?:[^"\\]|\\.)*"\s*$/gm
        const lineContent = blockContent.substring(
          blockContent.lastIndexOf('\n', pkgMatch.index) + 1,
          blockContent.indexOf('\n', pkgMatch.index) === -1 ? blockContent.length : blockContent.indexOf('\n', pkgMatch.index),
        )
        if (aliasCheckRegex.test(lineContent)) continue
        if (pkgName.startsWith('_')) continue
        declarations.push({
          name: pkgName,
          line: getLineNumber(source, match.index + pkgMatch.index),
          snippet: pkgMatch[0].trim(),
        })
      }
    }

    // 单行 import "pkg/path"
    const singleImportRegex = /import\s+(?:(\w+)\s+)?"([^"]+)"/g
    while ((match = singleImportRegex.exec(source)) !== null) {
      const alias = match[1]
      if (alias === '_' || alias === '.') continue
      if (alias) {
        if (alias.startsWith('_')) continue
        declarations.push({
          name: alias,
          line: getLineNumber(source, match.index),
          snippet: match[0].trim(),
        })
      } else {
        const pkgName = match[2]!.split('/').pop()!
        if (pkgName.startsWith('_')) continue
        declarations.push({
          name: pkgName,
          line: getLineNumber(source, match.index),
          snippet: match[0].trim(),
        })
      }
    }

    // 短变量声明: xxx := ...
    const shortVarRegex = /(\w+)\s*:=/g
    while ((match = shortVarRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_')) continue
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    // var xxx = ... 或 var xxx type
    const varRegex = /var\s+(\w+)\s+/g
    while ((match = varRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_')) continue
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    return this.findUnused(declarations, source, filePath, symbolTable, projectSymbols, codeGraph)
  }

  // ==================== Java ====================

  private checkJava(source: string, filePath: string, symbolTable: import('../core/type-inferencer.js').SymbolTable | null, projectSymbols?: ProjectSymbolIndex, codeGraph?: CodeGraph): Issue[] {
    const declarations: Declaration[] = []

    // import xxx.yyy.ClassName;
    const importRegex = /import\s+(?:static\s+)?[\w.]+\.(\w+)\s*;/g
    let match: RegExpExecArray | null
    while ((match = importRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_') || name === '*') continue
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    // 局部变量: Type name = ...
    const varRegex = /(?:^|\s)(?:final\s+)?(?:\w+(?:<[^>]+>)?(?:\[\])?)\s+(\w+)\s*=/gm
    while ((match = varRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_')) continue
      // 排除 Java 关键字
      if (this.isJavaKeyword(name)) continue
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    return this.findUnused(declarations, source, filePath, symbolTable, projectSymbols, codeGraph)
  }

  private isJavaKeyword(name: string): boolean {
    const keywords = new Set([
      'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
      'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
      'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
      'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package',
      'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
      'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient',
      'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
    ])
    return keywords.has(name)
  }

  // ==================== Rust ====================

  private checkRust(source: string, filePath: string, symbolTable: import('../core/type-inferencer.js').SymbolTable | null, projectSymbols?: ProjectSymbolIndex, codeGraph?: CodeGraph): Issue[] {
    const declarations: Declaration[] = []

    // use xxx::yyy;
    const useRegex = /use\s+[\w:]+::(\w+)/g
    let match: RegExpExecArray | null
    while ((match = useRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_') || name === 'self' || name === 'super' || name === 'crate') continue
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    // let name = ... / let mut name = ...
    const letRegex = /let\s+(?:mut\s+)?(\w+)\s*(?::\s*[^=]+)?\s*=/g
    while ((match = letRegex.exec(source)) !== null) {
      const name = match[1]
      if (name.startsWith('_')) continue
      if (name === 'self') continue
      declarations.push({
        name,
        line: getLineNumber(source, match.index),
        snippet: match[0].trim(),
      })
    }

    return this.findUnused(declarations, source, filePath, symbolTable, projectSymbols, codeGraph)
  }

  // ==================== 公共逻辑 ====================

  private findUnused(declarations: Declaration[], source: string, filePath: string, symbolTable: import('../core/type-inferencer.js').SymbolTable | null, projectSymbols?: ProjectSymbolIndex, codeGraph?: CodeGraph): Issue[] {
    const issues: Issue[] = []
    const seen = new Set<string>()

    for (const decl of declarations) {
      // 去重：同一变量名在同一行不重复报告
      const key = `${decl.name}:${decl.line}`
      if (seen.has(key)) continue
      seen.add(key)

      // 跳过占位符变量名（xxx, yyy, TODO 等）
      if (PLACEHOLDER_NAME_REGEX.test(decl.name)) continue

      // 代码图增强：检查此符号在此文件中是否有跨文件引用
      if (codeGraph) {
        const defs = codeGraph.symbols.get(decl.name)
        if (defs) {
          // 查找在此文件中定义的版本，检查是否有来自其他文件的引用
          const localDef = defs.find(d => d.file === filePath)
          if (localDef && localDef.refCount > 0) continue
          // 如果符号在代码图中但不在本文件定义，继续检查
        }
        // 如果代码图可用，用它的 referencedAcrossFiles
        if (codeGraph.referencedAcrossFiles.has(decl.name)) continue
      } else if (projectSymbols && projectSymbols.referencedAcrossFiles.has(decl.name)) continue

      // 符号表增强模式：使用排除字符串/注释的引用追踪
      if (symbolTable) {
        // 导出的符号跳过（可能被其他文件使用）
        if (isExported(symbolTable, decl.name)) continue

        // 使用符号表的精确引用判断
        const used = isReferenced(symbolTable, decl.name)
        if (!used) {
          issues.push({
            rule: this.rule,
            severity: 'low',
            confidence: 'medium',
            category: 'quality',
            file: filePath,
            line: decl.line,
            message: `未使用的声明: "${decl.name}"`,
            snippet: decl.snippet,
            suggestion: `如果确实不需要使用，请以 "_" 开头命名；否则请删除此声明`,
          })
        }
        continue
      }

      const searchableSource = this.getSearchableSource(source, filePath)
      const regex = new RegExp(`\\b${escapeRegex(decl.name)}\\b`, 'g')
      const occurrences = (searchableSource.match(regex) || []).length

      // 只出现 1 次 = 只有声明，没有使用
      if (occurrences <= 1) {
        // 模块级函数（Python def）：可能被其他文件导入，降低置信度
        const confidence: Confidence = decl._moduleLevelFunc ? 'low' : 'medium'
        issues.push({
          rule: this.rule,
          severity: 'low',
          confidence,
          category: 'quality',
          file: filePath,
          line: decl.line,
          message: `未使用的声明: "${decl.name}"`,
          snippet: decl.snippet,
          suggestion: decl._moduleLevelFunc
            ? `此函数可能是被其他文件导入使用的，请确认后再决定是否删除`
            : `如果确实不需要使用，请以 "_" 开头命名；否则请删除此声明`,
        })
      }
    }

    return issues
  }

  private getSearchableSource(source: string, filePath: string): string {
    const language = this.languageFromFilePath(filePath)
    return source.split('\n').map(line => stripStrings(stripComments(line, language), language)).join('\n')
  }

  private languageFromFilePath(filePath: string): string {
    if (/\.py$/i.test(filePath)) return 'python'
    if (/\.go$/i.test(filePath)) return 'go'
    if (/\.java$/i.test(filePath)) return 'java'
    if (/\.rs$/i.test(filePath)) return 'rust'
    return 'typescript'
  }

  // ==================== 工具方法 ====================

  /** 获取 Python 类体的行号范围（用于判断函数是否在类内） */
  private getClassBodyRanges(source: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = []
    const classRegex = /^(\s*)class\s+\w+/gm
    let match: RegExpExecArray | null
    while ((match = classRegex.exec(source)) !== null) {
      const classIndent = match[1].length
      const classStartLine = getLineNumber(source, match.index)
      // 向下查找类体结束（缩进回到 class 级别或更小）
      const lines = source.split('\n')
      let classEndLine = lines.length
      for (let i = classStartLine; i < lines.length; i++) {
        const line = lines[i]
        if (line.trim() === '') continue
        const lineIndent = line.length - line.trimStart().length
        if (i > classStartLine && lineIndent <= classIndent && line.trim() !== '') {
          classEndLine = i
          break
        }
      }
      ranges.push([classStartLine, classEndLine])
    }
    return ranges
  }

  private isPythonKeyword(name: string): boolean {
    const keywords = new Set([
      'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
      'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
      'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
      'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
      'while', 'with', 'yield',
    ])
    return keywords.has(name)
  }
}
