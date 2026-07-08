/**
 * AIDE - 轻量结构化解析器
 * 用正则提取代码结构信息（函数/类/变量/import/作用域）
 *
 * 设计原则：
 * - 零外部依赖，不依赖 tree-sitter 等 native 模块
 * - 解析失败 → 返回 null，检测器降级到纯文本模式
 * - 未来可无缝替换为 tree-sitter（接口不变）
 *
 * 支持语言：Python / JavaScript / TypeScript / Go / Java / Rust / Ruby / PHP
 */

import type { Language } from '../types/index.js'

// ==================== AST 数据结构 ====================

/** AST 节点类型 */
export type ASTNodeType =
  | 'module'       // 文件根节点
  | 'function'     // 函数/方法定义
  | 'class'        // 类定义
  | 'method'       // 类方法
  | 'variable'     // 变量声明
  | 'import'       // 导入语句
  | 'if'           // if 分支
  | 'for'          // for 循环
  | 'while'        // while 循环
  | 'try'          // try/catch 块
  | 'with'         // with 语句（Python）
  | 'return'       // return 语句
  | 'raise'        // raise 语句（Python）
  | 'throw'        // throw 语句
  | 'assign'       // 赋值语句

/** AST 节点 */
export interface ASTNode {
  /** 节点类型 */
  type: ASTNodeType
  /** 标识符名称（函数名/类名/变量名等） */
  name?: string
  /** 起始行（从 1 开始） */
  startLine: number
  /** 结束行（从 1 开始） */
  endLine: number
  /** 子节点 */
  children: ASTNode[]
  /** 附加属性 */
  attrs?: Record<string, string>
}

/** 解析结果 */
export interface ParseResult {
  /** 根节点 */
  root: ASTNode
  /** 快速索引：所有函数定义 */
  functions: ASTNode[]
  /** 快速索引：所有类定义 */
  classes: ASTNode[]
  /** 快速索引：所有导入语句 */
  imports: ASTNode[]
  /** 快速索引：所有变量声明 */
  variables: ASTNode[]
  /** 快速索引：所有 try/catch 块 */
  tryBlocks: ASTNode[]
}

// ==================== 解析入口 ====================

/**
 * 解析源码为结构化 AST。
 * 返回 null 表示不支持的语言或解析失败。
 */
export function parseAST(source: string, language: Language): ParseResult | null {
  switch (language) {
    case 'python': return parsePython(source)
    case 'javascript':
    case 'typescript': return parseJavaScript(source)
    case 'go': return parseGo(source)
    case 'java': return parseJava(source)
    case 'rust': return parseRust(source)
    case 'ruby': return parseRuby(source)
    case 'php': return parsePHP(source)
    default: return null
  }
}

// ==================== Python 解析 ====================

function parsePython(source: string): ParseResult {
  const lines = source.split('\n')
  const root: ASTNode = { type: 'module', startLine: 1, endLine: lines.length, children: [] }
  const functions: ASTNode[] = []
  const classes: ASTNode[] = []
  const imports: ASTNode[] = []
  const variables: ASTNode[] = []
  const tryBlocks: ASTNode[] = []

  // 用缩进栈跟踪作用域
  const scopeStack: Array<{ indent: number; node: ASTNode }> = [{ indent: -1, node: root }]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const indent = line.length - line.trimStart().length

    // 弹出已结束的作用域
    while (scopeStack.length > 1 && indent <= scopeStack[scopeStack.length - 1]!.indent) {
      const closed = scopeStack.pop()!
      closed.node.endLine = i
    }

    const parent = scopeStack[scopeStack.length - 1]!.node

    // import 语句
    const importMatch = trimmed.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/)
    if (importMatch) {
      const node: ASTNode = { type: 'import', name: importMatch[1] || importMatch[2].split(',')[0]!.trim(), startLine: i + 1, endLine: i + 1, children: [] }
      parent.children.push(node)
      imports.push(node)
      continue
    }

    // class 定义
    const classMatch = trimmed.match(/^class\s+(\w+)/)
    if (classMatch) {
      const node: ASTNode = { type: 'class', name: classMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      parent.children.push(node)
      classes.push(node)
      scopeStack.push({ indent, node })
      continue
    }

    // function/method 定义
    const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/)
    if (funcMatch) {
      const isMethod = parent.type === 'class'
      const node: ASTNode = { type: isMethod ? 'method' : 'function', name: funcMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      parent.children.push(node)
      functions.push(node)
      scopeStack.push({ indent, node })
      continue
    }

    // try 块
    if (/^try\s*:/.test(trimmed)) {
      const node: ASTNode = { type: 'try', startLine: i + 1, endLine: i + 1, children: [] }
      parent.children.push(node)
      tryBlocks.push(node)
      scopeStack.push({ indent, node })
      continue
    }

    // with 块
    if (/^with\s+/.test(trimmed) && trimmed.endsWith(':')) {
      const withMatch = trimmed.match(/^with\s+(.+?)\s+as\s+(\w+)/)
      const node: ASTNode = { type: 'with', name: withMatch?.[2], startLine: i + 1, endLine: i + 1, children: [], attrs: withMatch ? { context: withMatch[1] } : undefined }
      parent.children.push(node)
      scopeStack.push({ indent, node })
      continue
    }

    // for 循环
    if (/^for\s+/.test(trimmed) && trimmed.endsWith(':')) {
      const forMatch = trimmed.match(/^for\s+(\w+)/)
      const node: ASTNode = { type: 'for', name: forMatch?.[1], startLine: i + 1, endLine: i + 1, children: [] }
      parent.children.push(node)
      scopeStack.push({ indent, node })
      continue
    }

    // while 循环
    if (/^while\s+/.test(trimmed) && trimmed.endsWith(':')) {
      const node: ASTNode = { type: 'while', startLine: i + 1, endLine: i + 1, children: [] }
      parent.children.push(node)
      scopeStack.push({ indent, node })
      continue
    }

    // if 分支
    if (/^if\s+/.test(trimmed) && trimmed.endsWith(':')) {
      const node: ASTNode = { type: 'if', startLine: i + 1, endLine: i + 1, children: [] }
      parent.children.push(node)
      scopeStack.push({ indent, node })
      continue
    }

    // return 语句
    if (/^return\b/.test(trimmed)) {
      const node: ASTNode = { type: 'return', startLine: i + 1, endLine: i + 1, children: [] }
      parent.children.push(node)
      continue
    }

    // raise 语句
    if (/^raise\b/.test(trimmed)) {
      const node: ASTNode = { type: 'raise', startLine: i + 1, endLine: i + 1, children: [] }
      parent.children.push(node)
      continue
    }

    // 模块级变量赋值（仅在根作用域）
    if (parent === root && /^\w+\s*(?::\s*\w[\w\[\],\s]*\s*)?=/.test(trimmed)) {
      const varMatch = trimmed.match(/^(\w+)\s*(?::\s*\w[\w\[\],\s]*\s*)?=/)
      if (varMatch && !/^(class|def|if|for|while|try|with|return|raise|import|from)\b/.test(varMatch[1])) {
        const node: ASTNode = { type: 'variable', name: varMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
        parent.children.push(node)
        variables.push(node)
      }
    }
  }

  // 关闭所有未闭合的作用域
  for (const entry of scopeStack) {
    entry.node.endLine = lines.length
  }

  return { root, functions, classes, imports, variables, tryBlocks }
}

// ==================== JavaScript/TypeScript 解析 ====================

function parseJavaScript(source: string): ParseResult {
  const lines = source.split('\n')
  const root: ASTNode = { type: 'module', startLine: 1, endLine: lines.length, children: [] }
  const functions: ASTNode[] = []
  const classes: ASTNode[] = []
  const imports: ASTNode[] = []
  const variables: ASTNode[] = []
  const tryBlocks: ASTNode[] = []

  // 用花括号计数跟踪块作用域
  let braceDepth = 0
  const braceStack: Array<{ depth: number; node: ASTNode; line: number }> = [{ depth: 0, node: root, line: 1 }]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue

    // import 语句
    const importMatch = trimmed.match(/^import\s+.*?\s+from\s+['"`]([^'"`]+)['"`]/)
      || trimmed.match(/^import\s+['"`]([^'"`]+)['"`]/)
    if (importMatch) {
      const node: ASTNode = { type: 'import', name: importMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      imports.push(node)
      continue
    }

    // require 语句
    const requireMatch = trimmed.match(/require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/)
    if (requireMatch) {
      const node: ASTNode = { type: 'import', name: requireMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      imports.push(node)
    }

    // class 定义
    const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+(\w+)/)
    if (classMatch) {
      const node: ASTNode = { type: 'class', name: classMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      classes.push(node)
      // 跟踪花括号确定结束行
      if (trimmed.includes('{')) {
        braceStack.push({ depth: braceDepth, node, line: i + 1 })
      }
    }

    // function 定义
    const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
      || trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s*\*\s*(\w+)/)  // generator
    if (funcMatch) {
      const node: ASTNode = { type: 'function', name: funcMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      functions.push(node)
      if (trimmed.includes('{')) {
        braceStack.push({ depth: braceDepth, node, line: i + 1 })
      }
    }

    // 箭头函数 / 函数表达式赋值
    const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/)
    if (arrowMatch) {
      const node: ASTNode = { type: 'function', name: arrowMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      functions.push(node)
    }

    // method 定义（class 内部）
    const methodMatch = trimmed.match(/^(?:async\s+)?(?:\*?\s*)(\w+)\s*\([^)]*\)\s*(?::\s*\w+(?:<[^>]+>)?)?\s*\{/)
    if (methodMatch && !/^(if|for|while|switch|catch|constructor)\b/.test(methodMatch[1])) {
      const node: ASTNode = { type: 'method', name: methodMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      functions.push(node)
    }

    // try 块
    if (/^try\s*\{/.test(trimmed)) {
      const node: ASTNode = { type: 'try', startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      tryBlocks.push(node)
      braceStack.push({ depth: braceDepth, node, line: i + 1 })
    }

    // 变量声明
    const varMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)/)
    if (varMatch && !arrowMatch) {
      const node: ASTNode = { type: 'variable', name: varMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      variables.push(node)
    }

    // return 语句
    if (/^return\b/.test(trimmed)) {
      const node: ASTNode = { type: 'return', startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
    }

    // throw 语句
    if (/^throw\b/.test(trimmed)) {
      const node: ASTNode = { type: 'throw', startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
    }

    // 跟踪花括号深度
    for (const ch of trimmed) {
      if (ch === '{') {
        braceDepth++
      } else if (ch === '}') {
        braceDepth--
        // 检查是否有作用域结束
        while (braceStack.length > 1 && braceStack[braceStack.length - 1]!.depth >= braceDepth) {
          const closed = braceStack.pop()!
          closed.node.endLine = i + 1
        }
      }
    }
  }

  // 关闭未闭合的块
  for (const entry of braceStack) {
    entry.node.endLine = lines.length
  }

  return { root, functions, classes, imports, variables, tryBlocks }
}

// ==================== Go 解析 ====================

function parseGo(source: string): ParseResult {
  const lines = source.split('\n')
  const root: ASTNode = { type: 'module', startLine: 1, endLine: lines.length, children: [] }
  const functions: ASTNode[] = []
  const classes: ASTNode[] = []
  const imports: ASTNode[] = []
  const variables: ASTNode[] = []
  const tryBlocks: ASTNode[] = []

  let braceDepth = 0
  const braceStack: Array<{ depth: number; node: ASTNode }> = [{ depth: 0, node: root }]

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith('//')) continue

    // import 语句
    const singleImport = trimmed.match(/^import\s+"([^"]+)"/)
    if (singleImport) {
      const node: ASTNode = { type: 'import', name: singleImport[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      imports.push(node)
      continue
    }

    // func 定义
    const funcMatch = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/)
    if (funcMatch) {
      const node: ASTNode = { type: 'function', name: funcMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      functions.push(node)
      if (trimmed.includes('{')) {
        braceStack.push({ depth: braceDepth, node })
      }
    }

    // type 结构体（Go 的"类"）
    const structMatch = trimmed.match(/^type\s+(\w+)\s+struct/)
    if (structMatch) {
      const node: ASTNode = { type: 'class', name: structMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      classes.push(node)
      if (trimmed.includes('{')) {
        braceStack.push({ depth: braceDepth, node })
      }
    }

    // 跟踪花括号
    for (const ch of trimmed) {
      if (ch === '{') braceDepth++
      else if (ch === '}') {
        braceDepth--
        while (braceStack.length > 1 && braceStack[braceStack.length - 1]!.depth >= braceDepth) {
          braceStack.pop()!.node.endLine = i + 1
        }
      }
    }
  }

  for (const entry of braceStack) entry.node.endLine = lines.length
  return { root, functions, classes, imports, variables, tryBlocks }
}

// ==================== Java 解析 ====================

function parseJava(source: string): ParseResult {
  const lines = source.split('\n')
  const root: ASTNode = { type: 'module', startLine: 1, endLine: lines.length, children: [] }
  const functions: ASTNode[] = []
  const classes: ASTNode[] = []
  const imports: ASTNode[] = []
  const variables: ASTNode[] = []
  const tryBlocks: ASTNode[] = []

  let braceDepth = 0
  const braceStack: Array<{ depth: number; node: ASTNode }> = [{ depth: 0, node: root }]

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue

    // import 语句
    const importMatch = trimmed.match(/^import\s+(?:static\s+)?([^;]+);/)
    if (importMatch) {
      const node: ASTNode = { type: 'import', name: importMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      imports.push(node)
      continue
    }

    // class 定义
    const classMatch = trimmed.match(/(?:public|protected|private)?\s*(?:static\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/)
    if (classMatch) {
      const node: ASTNode = { type: 'class', name: classMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      classes.push(node)
      if (trimmed.includes('{')) braceStack.push({ depth: braceDepth, node })
    }

    // method 定义
    const methodMatch = trimmed.match(/(?:public|protected|private)?\s*(?:static\s+)?(?:synchronized\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/)
    if (methodMatch && !/^(if|for|while|switch|catch|class)\b/.test(methodMatch[1])) {
      const node: ASTNode = { type: 'method', name: methodMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      functions.push(node)
      braceStack.push({ depth: braceDepth, node })
    }

    // try 块
    if (/^try\s*\{/.test(trimmed)) {
      const node: ASTNode = { type: 'try', startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      tryBlocks.push(node)
      braceStack.push({ depth: braceDepth, node })
    }

    // 跟踪花括号
    for (const ch of trimmed) {
      if (ch === '{') braceDepth++
      else if (ch === '}') {
        braceDepth--
        while (braceStack.length > 1 && braceStack[braceStack.length - 1]!.depth >= braceDepth) {
          braceStack.pop()!.node.endLine = i + 1
        }
      }
    }
  }

  for (const entry of braceStack) entry.node.endLine = lines.length
  return { root, functions, classes, imports, variables, tryBlocks }
}

// ==================== Rust 解析 ====================

function parseRust(source: string): ParseResult {
  const lines = source.split('\n')
  const root: ASTNode = { type: 'module', startLine: 1, endLine: lines.length, children: [] }
  const functions: ASTNode[] = []
  const classes: ASTNode[] = []
  const imports: ASTNode[] = []
  const variables: ASTNode[] = []
  const tryBlocks: ASTNode[] = []

  let braceDepth = 0
  const braceStack: Array<{ depth: number; node: ASTNode }> = [{ depth: 0, node: root }]

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith('//')) continue

    // use 语句
    const useMatch = trimmed.match(/^use\s+([^;]+);/)
    if (useMatch) {
      const node: ASTNode = { type: 'import', name: useMatch[1].trim(), startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      imports.push(node)
      continue
    }

    // fn 定义
    const fnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/)
    if (fnMatch) {
      const node: ASTNode = { type: 'function', name: fnMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      functions.push(node)
      if (trimmed.includes('{')) braceStack.push({ depth: braceDepth, node })
    }

    // struct 定义
    const structMatch = trimmed.match(/^(?:pub\s+)?struct\s+(\w+)/)
    if (structMatch) {
      const node: ASTNode = { type: 'class', name: structMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      classes.push(node)
      if (trimmed.includes('{')) braceStack.push({ depth: braceDepth, node })
    }

    // 跟踪花括号
    for (const ch of trimmed) {
      if (ch === '{') braceDepth++
      else if (ch === '}') {
        braceDepth--
        while (braceStack.length > 1 && braceStack[braceStack.length - 1]!.depth >= braceDepth) {
          braceStack.pop()!.node.endLine = i + 1
        }
      }
    }
  }

  for (const entry of braceStack) entry.node.endLine = lines.length
  return { root, functions, classes, imports, variables, tryBlocks }
}

// ==================== Ruby 解析 ====================

function parseRuby(source: string): ParseResult {
  const lines = source.split('\n')
  const root: ASTNode = { type: 'module', startLine: 1, endLine: lines.length, children: [] }
  const functions: ASTNode[] = []
  const classes: ASTNode[] = []
  const imports: ASTNode[] = []
  const variables: ASTNode[] = []
  const tryBlocks: ASTNode[] = []

  // Ruby 用 end 关闭块，用关键字栈跟踪
  const endStack: Array<{ node: ASTNode; line: number }> = [{ node: root, line: 1 }]

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // require 语句
    const requireMatch = trimmed.match(/^require\s+['"]([^'"]+)['"]/)
    if (requireMatch) {
      const node: ASTNode = { type: 'import', name: requireMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      imports.push(node)
      continue
    }

    // class 定义
    const classMatch = trimmed.match(/^class\s+(\w+)/)
    if (classMatch) {
      const node: ASTNode = { type: 'class', name: classMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      classes.push(node)
      endStack.push({ node, line: i + 1 })
      continue
    }

    // method 定义
    const methodMatch = trimmed.match(/^def\s+(\w+)/)
    if (methodMatch) {
      const node: ASTNode = { type: 'method', name: methodMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      functions.push(node)
      endStack.push({ node, line: i + 1 })
      continue
    }

    // begin/rescue 块（Ruby 的 try/catch）
    if (/^begin\b/.test(trimmed)) {
      const node: ASTNode = { type: 'try', startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      tryBlocks.push(node)
      endStack.push({ node, line: i + 1 })
      continue
    }

    // end 关闭块
    if (/^end\b/.test(trimmed) && endStack.length > 1) {
      endStack.pop()!.node.endLine = i + 1
    }
  }

  for (const entry of endStack) entry.node.endLine = lines.length
  return { root, functions, classes, imports, variables, tryBlocks }
}

// ==================== PHP 解析 ====================

function parsePHP(source: string): ParseResult {
  const lines = source.split('\n')
  const root: ASTNode = { type: 'module', startLine: 1, endLine: lines.length, children: [] }
  const functions: ASTNode[] = []
  const classes: ASTNode[] = []
  const imports: ASTNode[] = []
  const variables: ASTNode[] = []
  const tryBlocks: ASTNode[] = []

  let braceDepth = 0
  const braceStack: Array<{ depth: number; node: ASTNode }> = [{ depth: 0, node: root }]

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue

    // use 语句
    const useMatch = trimmed.match(/^use\s+([^;]+);/)
    if (useMatch) {
      const node: ASTNode = { type: 'import', name: useMatch[1].trim(), startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      imports.push(node)
      continue
    }

    // class 定义
    const classMatch = trimmed.match(/(?:abstract\s+|final\s+)?class\s+(\w+)/)
    if (classMatch) {
      const node: ASTNode = { type: 'class', name: classMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      classes.push(node)
      if (trimmed.includes('{')) braceStack.push({ depth: braceDepth, node })
    }

    // function 定义
    const funcMatch = trimmed.match(/(?:public|protected|private)?\s*(?:static\s+)?function\s+(\w+)/)
    if (funcMatch) {
      const node: ASTNode = { type: 'function', name: funcMatch[1], startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      functions.push(node)
      if (trimmed.includes('{')) braceStack.push({ depth: braceDepth, node })
    }

    // try 块
    if (/^try\s*\{/.test(trimmed)) {
      const node: ASTNode = { type: 'try', startLine: i + 1, endLine: i + 1, children: [] }
      root.children.push(node)
      tryBlocks.push(node)
      braceStack.push({ depth: braceDepth, node })
    }

    // 跟踪花括号
    for (const ch of trimmed) {
      if (ch === '{') braceDepth++
      else if (ch === '}') {
        braceDepth--
        while (braceStack.length > 1 && braceStack[braceStack.length - 1]!.depth >= braceDepth) {
          braceStack.pop()!.node.endLine = i + 1
        }
      }
    }
  }

  for (const entry of braceStack) entry.node.endLine = lines.length
  return { root, functions, classes, imports, variables, tryBlocks }
}
