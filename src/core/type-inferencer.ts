/**
 * AIDE - 单文件类型推断器
 * 从 ParseResult 构建符号表 + 引用追踪
 *
 * 核心能力：
 * - 符号表：记录文件中所有定义的名称（函数/类/变量/import）及其作用域
 * - 引用追踪：记录哪些名称在代码中被引用（排除字符串/注释中的误匹配）
 * - 作用域感知：区分模块级/函数级/类级定义
 *
 * 设计原则：
 * - 仅当 ctx.ast 存在时使用（Feature Flag 控制）
 * - 解析失败 → 返回 null，检测器降级到纯文本模式
 */

import type { ParseResult, ASTNode } from './ast-parser.js'

// ==================== 符号表数据结构 ====================

/** 符号作用域 */
export type SymbolScope = 'module' | 'function' | 'class' | 'method' | 'block'

/** 符号种类 */
export type SymbolKind = 'function' | 'class' | 'variable' | 'import' | 'parameter'

/** 符号定义 */
export interface SymbolDef {
  /** 符号名称 */
  name: string
  /** 符号种类 */
  kind: SymbolKind
  /** 所在作用域 */
  scope: SymbolScope
  /** 定义所在行 */
  line: number
  /** 是否被导出（模块级公共 API） */
  exported: boolean
  /** 定义所在的 AST 节点 */
  node: ASTNode
}

/** 符号表 */
export interface SymbolTable {
  /** 所有定义 */
  definitions: SymbolDef[]
  /** 被引用的名称集合（排除字符串/注释） */
  referencedNames: Set<string>
  /** 按名称索引的定义 */
  byName: Map<string, SymbolDef[]>
  /** 模块级导出的名称 */
  exportedNames: Set<string>
}

// ==================== 推断入口 ====================

/**
 * 从 ParseResult 构建符号表。
 * 返回 null 表示解析失败。
 */
export function buildSymbolTable(
  parseResult: ParseResult | null | undefined,
  source: string,
  language: string,
): SymbolTable | null {
  if (!parseResult) return null

  const definitions: SymbolDef[] = []
  const referencedNames = new Set<string>()
  const byName = new Map<string, SymbolDef[]>()
  const exportedNames = new Set<string>()

  // 1. 从 AST 收集定义
  collectDefinitions(parseResult.root, 'module', false, definitions, exportedNames, language)

  // 2. 从源码收集引用（排除字符串和注释）
  collectReferences(source, language, referencedNames)

  // 3. 构建名称索引
  for (const def of definitions) {
    const list = byName.get(def.name) || []
    list.push(def)
    byName.set(def.name, list)
  }

  return { definitions, referencedNames, byName, exportedNames }
}

/** 判断符号是否被引用（排除字符串/注释中的误匹配） */
export function isReferenced(table: SymbolTable, name: string): boolean {
  return table.referencedNames.has(name)
}

/** 判断符号是否被导出 */
export function isExported(table: SymbolTable, name: string): boolean {
  return table.exportedNames.has(name)
}

// ==================== 定义收集 ====================

function collectDefinitions(
  node: ASTNode,
  scope: SymbolScope,
  isExported: boolean,
  definitions: SymbolDef[],
  exportedNames: Set<string>,
  language: string,
): void {
  for (const child of node.children) {
    const childScope = getScopeForNode(child, scope)
    const childExported = isExported || childExportedCheck(child, scope, language)

    switch (child.type) {
      case 'function': {
        const def: SymbolDef = {
          name: child.name || '',
          kind: 'function',
          scope: childScope,
          line: child.startLine,
          exported: childExported,
          node: child,
        }
        definitions.push(def)
        if (childExported) exportedNames.add(def.name)
        // 递归收集函数体内的定义
        collectDefinitions(child, 'function', false, definitions, exportedNames, language)
        break
      }
      case 'method': {
        const def: SymbolDef = {
          name: child.name || '',
          kind: 'function',
          scope: 'method',
          line: child.startLine,
          exported: childExported,
          node: child,
        }
        definitions.push(def)
        collectDefinitions(child, 'method', false, definitions, exportedNames, language)
        break
      }
      case 'class': {
        const def: SymbolDef = {
          name: child.name || '',
          kind: 'class',
          scope: childScope,
          line: child.startLine,
          exported: childExported,
          node: child,
        }
        definitions.push(def)
        if (childExported) exportedNames.add(def.name)
        collectDefinitions(child, 'class', false, definitions, exportedNames, language)
        break
      }
      case 'variable': {
        const def: SymbolDef = {
          name: child.name || '',
          kind: 'variable',
          scope: childScope,
          line: child.startLine,
          exported: childExported,
          node: child,
        }
        definitions.push(def)
        if (childExported) exportedNames.add(def.name)
        break
      }
      case 'import': {
        const def: SymbolDef = {
          name: child.name || '',
          kind: 'import',
          scope: 'module',
          line: child.startLine,
          exported: false,
          node: child,
        }
        definitions.push(def)
        break
      }
      default:
        // 其他节点（if/for/try 等）递归收集子定义
        collectDefinitions(child, childScope, childExported, definitions, exportedNames, language)
        break
    }
  }
}

function getScopeForNode(node: ASTNode, parentScope: SymbolScope): SymbolScope {
  switch (node.type) {
    case 'function': return 'function'
    case 'method': return 'method'
    case 'class': return 'class'
    case 'if':
    case 'for':
    case 'while':
    case 'try':
    case 'with': return 'block'
    default: return parentScope
  }
}

function childExportedCheck(child: ASTNode, scope: SymbolScope, language: string): boolean {
  // 模块级的定义默认视为导出（可能被其他文件使用）
  if (scope === 'module') {
    // Python: 模块级 UPPER_CASE 常量视为导出
    if (language === 'python' && child.name && /^[A-Z][A-Z_0-9]+$/.test(child.name)) {
      return true
    }
    // JS/TS: export 修饰的视为导出（AST 中暂不区分，保守处理）
    // Go: 首字母大写的视为导出
    if (language === 'go' && child.name && /^[A-Z]/.test(child.name)) {
      return true
    }
    // Java: public 修饰的视为导出
    if (language === 'java' && child.name && /^[A-Z]/.test(child.name)) {
      return true
    }
  }
  return false
}

// ==================== 引用收集 ====================

/**
 * 从源码中收集标识符引用。
 * 排除字符串字面量和注释中的标识符。
 */
function collectReferences(
  source: string,
  language: string,
  referencedNames: Set<string>,
): void {
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!

    // 移除注释
    line = stripComments(line, language)

    // 移除字符串字面量
    line = stripStrings(line, language)

    // 提取标识符
    const identifierRegex = /\b([a-zA-Z_]\w*)\b/g
    let match: RegExpExecArray | null
    while ((match = identifierRegex.exec(line)) !== null) {
      referencedNames.add(match[1])
    }
  }
}

/** 移除行内注释 */
export function stripComments(line: string, language: string): string {
  switch (language) {
    case 'python':
    case 'ruby':
    case 'php':
      // 移除 # 注释（但保留字符串中的 #）
      return stripCommentAfter(line, '#')
    case 'javascript':
    case 'typescript':
    case 'go':
    case 'java':
    case 'rust':
    case 'kotlin':
    case 'swift':
    case 'csharp':
    case 'c':
    case 'cpp':
      // 移除 // 注释
      return stripCommentAfter(line, '//')
    default:
      return line
  }
}

/** 移除 // 或 # 之后的注释内容（但不在字符串内的） */
export function stripCommentAfter(line: string, marker: string): string {
  let inString: string | null = null
  for (let i = 0; i < line.length - marker.length + 1; i++) {
    const ch = line[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      if (inString === ch) inString = null
      else if (!inString) inString = ch
    }
    if (!inString && line.substring(i, i + marker.length) === marker) {
      return line.substring(0, i)
    }
  }
  return line
}

/** 移除字符串字面量 */
export function stripStrings(line: string, language: string): string {
  // 替换所有引号内的内容为空格
  let result = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      // 跳过整个字符串
      const quote = ch
      result += ' '
      i++
      while (i < line.length && line[i] !== quote) {
        if (line[i] === '\\' && i + 1 < line.length) {
          result += '  '
          i += 2
        } else {
          result += ' '
          i++
        }
      }
      if (i < line.length) {
        result += ' '
        i++
      }
    } else {
      result += ch
      i++
    }
  }
  return result
}
