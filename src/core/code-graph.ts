/**
 * AIDE - 项目代码符号依赖图
 *
 * 在第1遍扫描时构建，提供：
 * - 每个符号的定义位置（file:line）
 * - 每个符号的引用位置和引用计数
 * - 模块名到文件的映射（消除 package-hallucination 的全局 glob）
 * - 跨文件引用集合（与 module-resolver 输出兼容）
 *
 * 设计原则：
 * - 轻量正则提取（与 module-resolver 保持一致，不全量 AST 解析）
 * - 只跟踪项目内符号，不追踪 npm/PyPI 等外部包
 * - 解析失败 → 空图，调用方降级
 */

import type { Language } from '../types/index.js'

// ==================== 数据类型 ====================

/** 文件节点 */
export interface FileNode {
  /** 相对项目根目录的路径 */
  path: string
  /** 语言 */
  language: Language
  /** 导入声明列表 */
  imports: ImportEntry[]
  /** 导出的符号名列表 */
  exports: string[]
  /** 所有定义在此文件中的符号名 */
  definitions: string[]
}

/** 一条导入声明 */
export interface ImportEntry {
  /** 模块来源路径（如 './utils'、'lodash'、'..models'） */
  source: string
  /** 导入的符号名列表 */
  names: string[]
  /** 所在行号 */
  line: number
}

/** 符号定义和引用信息 */
export interface SymbolInfo {
  /** 符号名 */
  name: string
  /** 定义所在文件 */
  file: string
  /** 定义所在行号 */
  line: number
  /** 是否被导出（模块级公共 API） */
  exported: boolean
  /** 引用列表（项目内对此符号的所有引用位置） */
  references: Array<{ file: string; line: number }>
  /** 引用计数（有多少个位置引用了此符号） */
  refCount: number
}

/** 代码图 */
export interface CodeGraph {
  /** 文件索引 */
  files: Map<string, FileNode>
  /** 符号索引（符号名 → 定义位置列表，同名符号可能在不同文件中定义） */
  symbols: Map<string, SymbolInfo[]>
  /** 模块名索引（Python/JS 模块名 → 本地文件路径列表） */
  moduleToFiles: Map<string, string[]>
  /** 跨文件引用的符号名集合（与 module-resolver 输出兼容） */
  referencedAcrossFiles: Set<string>
}

// ==================== 图形构建 ====================

/**
 * 从文件列表构建项目代码符号依赖图。
 * 第1遍扫描时调用，结果注入到第2遍检测器的上下文中。
 */
export function buildCodeGraph(
  files: Array<{ filePath: string; language: Language; source: string }>,
): CodeGraph {
  const fileNodes = new Map<string, FileNode>()
  const symbols = new Map<string, SymbolInfo[]>()
  const moduleToFiles = new Map<string, string[]>()
  const referencedAcrossFiles = new Set<string>()

  // Pass 1: 提取每个文件的导入和导出
  for (const file of files) {
    const imports: ImportEntry[] = []
    const exports: string[] = []
    const definitions: string[] = []

    switch (file.language) {
      case 'python':
        extractPythonSymbols(file.source, imports, exports, definitions)
        break
      case 'typescript':
      case 'javascript':
        extractJSSymbols(file.source, imports, exports, definitions)
        break
      case 'go':
        extractGoSymbols(file.source, imports, exports, definitions)
        break
      case 'java':
        extractJavaSymbols(file.source, imports, exports, definitions)
        break
      case 'rust':
        extractRustSymbols(file.source, imports, exports, definitions)
        break
      case 'ruby':
        extractRubySymbols(file.source, imports, exports, definitions)
        break
    }

    fileNodes.set(file.filePath, {
      path: file.filePath,
      language: file.language,
      imports,
      exports,
      definitions,
    })

    // 注册模块名
    registerModuleNames(file.filePath, file.language, moduleToFiles)

    // 注册符号定义
    for (const name of exports) {
      const info: SymbolInfo = {
        name,
        file: file.filePath,
        line: 0, // 后面再精确设置
        exported: true,
        references: [],
        refCount: 0,
      }
      const list = symbols.get(name) || []
      list.push(info)
      symbols.set(name, list)
    }
    for (const name of definitions) {
      if (!exports.includes(name)) {
        const info: SymbolInfo = {
          name,
          file: file.filePath,
          line: 0,
          exported: false,
          references: [],
          refCount: 0,
        }
        const list = symbols.get(name) || []
        // 避免重复添加（已经在 exports 中加了）
        if (!list.some(s => s.file === file.filePath)) {
          list.push(info)
          symbols.set(name, list)
        }
      }
    }
  }

  // Pass 2: 解析导入引用 → 建立符号引用链
  for (const [filePath, node] of fileNodes) {
    for (const imp of node.imports) {
      // 只跟踪本地模块的导入（非相对路径 = 外部包，跳过）
      if (!imp.source.startsWith('.') && !imp.source.startsWith('/')) {
        // 外部包导入仍标记为跨文件引用（用于 unused-declaration）
        for (const name of imp.names) {
          referencedAcrossFiles.add(name)
        }
        continue
      }

      // 解析相对路径 → 找到目标文件
      const resolvedFile = resolveLocalImport(filePath, imp.source, fileNodes)
      if (!resolvedFile) continue

      const targetNode = fileNodes.get(resolvedFile)
      if (!targetNode) continue

      // 对每个导入的符号名，在目标定义上添加引用
      for (const name of imp.names) {
        const defs = symbols.get(name)
        if (!defs) {
          // 符号名不在任何已知的定义中 → 可能来自外部或动态，标记为跨文件引用
          referencedAcrossFiles.add(name)
          continue
        }
        // 找到此文件中的定义
        const localDef = defs.find(d => d.file === resolvedFile)
        if (localDef) {
          localDef.references.push({ file: filePath, line: imp.line })
          localDef.refCount++
          referencedAcrossFiles.add(name)
        } else {
          // 导入的符号在目标文件中未找到定义 → 可能是通配符或重导出
          referencedAcrossFiles.add(name)
        }
      }
    }
  }

  // Pass 3: 从源文件提取每个符号的精确行号
  // 构建 file->source 索引
  const fileSourceMap = new Map<string, string>()
  for (const f of files) {
    fileSourceMap.set(f.filePath, f.source)
  }

  for (const [name, defs] of symbols) {
    for (const def of defs) {
      const source = fileSourceMap.get(def.file)
      if (source) {
        def.line = findSymbolLine(source, name, 1)
      }
    }
  }

  return { files: fileNodes, symbols, moduleToFiles, referencedAcrossFiles }
}

// ==================== 符号提取函数（每语言） ====================

function extractPythonSymbols(
  source: string,
  imports: ImportEntry[],
  exports: string[],
  definitions: string[],
): void {
  // import xxx
  const importRegex = /^import\s+(\w+)/gm
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(source)) !== null) {
    imports.push({ source: match[1], names: [match[1]], line: getLine(source, match.index) })
    // 注意：不要将 import 来源添加到 definitions，因为它们是外部包
  }

  // from xxx import yyy
  const fromImportRegex = /^from\s+(\S+)\s+import\s+(.+)/gm
  while ((match = fromImportRegex.exec(source)) !== null) {
    const module = match[1]
    const names = match[2].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
    const line = getLine(source, match.index)
    for (const name of names) {
      if (!name || name === '*' || !/^[a-zA-Z_]\w*$/.test(name)) continue
      imports.push({ source: module, names: [name], line })
      // 只有 from . import 或 from .. import 的本地模块才添加到 definitions
      if (module.startsWith('.')) {
        definitions.push(name)
      }
    }
  }

  // def xxx / class xxx / 模块级 UPPER_CASE = ...
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('import') || trimmed.startsWith('from')) continue
    if (rawLine !== trimmed) continue // 只捕获模块级定义（无前导缩进）

    const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)/)
    if (funcMatch) {
      definitions.push(funcMatch[1])
      // 模块级 def 视为导出
      exports.push(funcMatch[1])
      continue
    }

    const classMatch = trimmed.match(/^class\s+(\w+)/)
    if (classMatch) {
      definitions.push(classMatch[1])
      exports.push(classMatch[1])
      continue
    }

    // UPPER_CASE 常量视为导出
    const constMatch = trimmed.match(/^([A-Z][A-Z_0-9]+)\s*=/)
    if (constMatch) {
      definitions.push(constMatch[1])
      exports.push(constMatch[1])
      continue
    }

    // 带类型注解的变量：xxx: Type = ...
    const typedVar = trimmed.match(/^(\w+)\s*:\s*\w+/)
    if (typedVar && !/^(class|def|if|for|while|try|with|return|raise|import|from)\b/.test(typedVar[1])) {
      definitions.push(typedVar[1])
    }
  }
}

function extractJSSymbols(
  source: string,
  imports: ImportEntry[],
  exports: string[],
  definitions: string[],
): void {
  // import { xxx } from '...'
  const namedImportRegex = /import\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = namedImportRegex.exec(source)) !== null) {
    const bindings = match[1].split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/)
      return parts.length > 1 ? parts[1]!.trim() : parts[0]!.trim()
    })
    const line = getLine(source, match.index)
    for (const name of bindings) {
      if (name && !name.startsWith('_')) {
        imports.push({ source: match[2]!, names: [name], line })
        definitions.push(name)
      }
    }
  }

  // import xxx from '...'
  const defaultImportRegex = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g
  while ((match = defaultImportRegex.exec(source)) !== null) {
    if (match[1] && !match[1].startsWith('_')) {
      imports.push({ source: match[2]!, names: [match[1]], line: getLine(source, match.index) })
      definitions.push(match[1])
    }
  }

  // import * as xxx from '...'
  const namespaceImportRegex = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g
  while ((match = namespaceImportRegex.exec(source)) !== null) {
    if (match[1] && !match[1].startsWith('_')) {
      imports.push({ source: match[2]!, names: [match[1]], line: getLine(source, match.index) })
      definitions.push(match[1])
    }
  }

  // export function xxx / export class xxx / export const xxx
  const exportFuncRegex = /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g
  while ((match = exportFuncRegex.exec(source)) !== null) {
    definitions.push(match[1])
    exports.push(match[1])
  }

  const exportClassRegex = /export\s+(?:default\s+)?class\s+(\w+)/g
  while ((match = exportClassRegex.exec(source)) !== null) {
    definitions.push(match[1])
    exports.push(match[1])
  }

  const exportConstRegex = /export\s+(?:const|let|var|type|interface)\s+(\w+)/g
  while ((match = exportConstRegex.exec(source)) !== null) {
    definitions.push(match[1])
    exports.push(match[1])
  }

  // export { xxx }
  const exportListRegex = /export\s*\{([^}]+)\}/g
  while ((match = exportListRegex.exec(source)) !== null) {
    const names = match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]!.trim())
    for (const name of names) {
      if (name && !name.startsWith('_')) {
        exports.push(name)
      }
    }
  }

  // const/let/var xxx = ...（模块级，非 export 不算导出但算定义）
  const varDeclRegex = /^\s*(?:const|let|var)\s+(\w+)\s*=/gm
  while ((match = varDeclRegex.exec(source)) !== null) {
    if (match[1] && !match[1].startsWith('_')) {
      definitions.push(match[1])
    }
  }

  // function xxx(...)
  const funcDeclRegex = /^(?:async\s+)?function\s+(\w+)\s*\(/gm
  while ((match = funcDeclRegex.exec(source)) !== null) {
    definitions.push(match[1])
  }

  // class xxx
  const classDeclRegex = /^class\s+(\w+)/gm
  while ((match = classDeclRegex.exec(source)) !== null) {
    definitions.push(match[1])
  }
}

function extractGoSymbols(
  source: string,
  imports: ImportEntry[],
  exports: string[],
  definitions: string[],
): void {
  // import "pkg" / import alias "pkg"
  const singleImportRegex = /import\s+(?:(\w+)\s+)?"([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = singleImportRegex.exec(source)) !== null) {
    const pkgName = match[1] || match[2]!.split('/').pop()!
    if (pkgName !== '_' && pkgName !== '.') {
      imports.push({ source: match[2]!, names: [pkgName], line: getLine(source, match.index) })
      definitions.push(pkgName)
    }
  }

  // import ( ... ) 块
  const importBlockRegex = /import\s*\(([\s\S]*?)\)/g
  while ((match = importBlockRegex.exec(source)) !== null) {
    const block = match[1]
    const aliasRegex = /(\w+)\s+"([^"]+)"/g
    let am: RegExpExecArray | null
    while ((am = aliasRegex.exec(block)) !== null) {
      if (am[1] !== '_' && am[1] !== '.') {
        imports.push({ source: am[2]!, names: [am[1]], line: getLine(source, match.index + am.index) })
        definitions.push(am[1])
      }
    }
    const pkgRegex = /"([^"]+)"/g
    let pm: RegExpExecArray | null
    while ((pm = pkgRegex.exec(block)) !== null) {
      const baseName = pm[1]!.split('/').pop()!
      if (baseName !== '_' && baseName !== '.') {
        // 检查是否已有别名（上面已处理）
        const lineStart = block.lastIndexOf('\n', pm.index) + 1
        const lineContent = block.slice(lineStart, block.indexOf('\n', pm.index) === -1 ? block.length : block.indexOf('\n', pm.index))
        if (/\w+\s+"/.test(lineContent)) continue
        imports.push({ source: pm[1]!, names: [baseName], line: getLine(source, match.index + pm.index) })
        definitions.push(baseName)
      }
    }
  }

  // func xxx / func (r T) xxx（首字母大写=导出）
  const funcRegex = /^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/gm
  while ((match = funcRegex.exec(source)) !== null) {
    definitions.push(match[1])
    if (/^[A-Z]/.test(match[1])) exports.push(match[1])
  }

  // type xxx
  const typeRegex = /^type\s+(\w+)\s+/gm
  while ((match = typeRegex.exec(source)) !== null) {
    definitions.push(match[1])
    if (/^[A-Z]/.test(match[1])) exports.push(match[1])
  }

  // var xxx
  const varRegex = /^var\s+(\w+)\s+/gm
  while ((match = varRegex.exec(source)) !== null) {
    definitions.push(match[1])
  }
}

function extractJavaSymbols(
  source: string,
  imports: ImportEntry[],
  exports: string[],
  definitions: string[],
): void {
  const importRegex = /import\s+(?:static\s+)?([\w.*]+)\s*;/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(source)) !== null) {
    const parts = match[1]!.split('.')
    const name = parts[parts.length - 1]!
    if (name !== '*') {
      imports.push({ source: match[1]!, names: [name], line: getLine(source, match.index) })
      definitions.push(name)
    }
  }

  const classRegex = /(?:public|protected)\s+(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/g
  while ((match = classRegex.exec(source)) !== null) {
    definitions.push(match[1])
    exports.push(match[1])
  }

  const methodRegex = /public\s+(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g
  while ((match = methodRegex.exec(source)) !== null) {
    if (!/^(if|for|while|switch|catch)\b/.test(match[1])) {
      definitions.push(match[1])
      exports.push(match[1])
    }
  }
}

function extractRustSymbols(
  source: string,
  imports: ImportEntry[],
  exports: string[],
  definitions: string[],
): void {
  const useRegex = /use\s+[\w:]+::(\w+)/g
  let match: RegExpExecArray | null
  while ((match = useRegex.exec(source)) !== null) {
    if (match[1] && !['self', 'super', 'crate'].includes(match[1])) {
      imports.push({ source: match[0]!, names: [match[1]], line: getLine(source, match.index) })
      definitions.push(match[1])
    }
  }

  const fnRegex = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g
  while ((match = fnRegex.exec(source)) !== null) {
    definitions.push(match[1])
  }

  const pubFnRegex = /pub\s+(?:async\s+)?fn\s+(\w+)/g
  while ((match = pubFnRegex.exec(source)) !== null) {
    exports.push(match[1])
  }

  const pubStructRegex = /pub\s+struct\s+(\w+)/g
  while ((match = pubStructRegex.exec(source)) !== null) {
    definitions.push(match[1])
    exports.push(match[1])
  }

  const pubEnumRegex = /pub\s+enum\s+(\w+)/g
  while ((match = pubEnumRegex.exec(source)) !== null) {
    definitions.push(match[1])
    exports.push(match[1])
  }
}

function extractRubySymbols(
  source: string,
  imports: ImportEntry[],
  exports: string[],
  definitions: string[],
): void {
  const requireRegex = /require(?:_relative)?\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = requireRegex.exec(source)) !== null) {
    const name = match[1]!.split('/').pop()!
    imports.push({ source: match[1]!, names: [name], line: getLine(source, match.index) })
    definitions.push(name)
  }

  const classRegex = /^class\s+(\w+)/gm
  while ((match = classRegex.exec(source)) !== null) {
    definitions.push(match[1])
    exports.push(match[1])
  }

  const moduleRegex = /^module\s+(\w+)/gm
  while ((match = moduleRegex.exec(source)) !== null) {
    definitions.push(match[1])
    exports.push(match[1])
  }

  const methodRegex = /^\s*def\s+(?:self\.)?(\w+)/gm
  while ((match = methodRegex.exec(source)) !== null) {
    definitions.push(match[1])
    exports.push(match[1])
  }
}

// ==================== 模块名注册 ====================

/**
 * 根据文件路径向模块名索引注册模块。
 * 例如：
 *   src/utils/helpers.py → 注册 helpers, src.utils.helpers
 *   src/utils/__init__.py → 注册 src.utils (目录→模块)
 *   src/index.ts → 注册 index 和 src/index
 */
function registerModuleNames(
  filePath: string,
  language: Language,
  moduleToFiles: Map<string, string[]>,
): void {
  // 标准化路径分隔符
  const normalized = filePath.replace(/\\/g, '/')
  const parts = normalized.split('/')
  const fileName = parts.pop() || ''
  const dirPath = parts.join('/')

  // 去掉扩展名
  const ext = '.' + fileName.split('.').pop()
  const baseName = fileName.slice(0, -ext.length)

  // 注册基本模块名
  addToModuleMap(moduleToFiles, baseName, filePath)

  // 注册带目录路径的模块名
  if (dirPath) {
    const fullModule = `${dirPath.replace(/\//g, '.')}.${baseName}`
    addToModuleMap(moduleToFiles, fullModule, filePath)
  }

  // Python __init__.py → 目录本身也是模块
  if (language === 'python' && baseName === '__init__') {
    const dirModule = dirPath.replace(/\//g, '.')
    if (dirModule) {
      addToModuleMap(moduleToFiles, dirModule, filePath)
    }
    
    // 支持 src layout：提取顶层包名
    // src/contract_comparator/__init__.py → 同时注册 contract_comparator
    const dirParts = dirModule.split('.')
    if (dirParts.length >= 2) {
      const firstPart = dirParts[0]
      if (firstPart === 'src' || firstPart === 'lib' || firstPart === 'source') {
        const topPackage = dirParts.slice(1).join('.')
        if (topPackage) {
          addToModuleMap(moduleToFiles, topPackage, filePath)
        }
      }
    }
  }
}

function addToModuleMap(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) || []
  if (!list.includes(value)) {
    list.push(value)
    map.set(key, list)
  }
}

// ==================== 本地导入解析 ====================

/**
 * 解析相对路径导入到目标文件路径。
 * 例如：filePath='src/app.ts', source='./utils/helper' → 'src/utils/helper.ts'
 */
function resolveLocalImport(
  filePath: string,
  source: string,
  fileNodes: Map<string, FileNode>,
): string | null {
  const normalized = filePath.replace(/\\/g, '/')
  const parts = normalized.split('/')
  parts.pop() // 去掉文件名
  const dir = parts.join('/')

  // 拼接相对路径
  const resolved = pathJoin(dir, source)

  // 尝试各种扩展名
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs', '.rb', '.php']
  for (const ext of extensions) {
    const fullPath = resolved + ext
    if (fileNodes.has(fullPath)) return fullPath
  }

  // 尝试 index 文件
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
    const indexPath = `${resolved}/index${ext}`
    if (fileNodes.has(indexPath)) return indexPath
  }

  // 尝试 Python __init__.py
  const initPath = `${resolved}/__init__.py`
  if (fileNodes.has(initPath)) return initPath

  return null
}

/** 简化的路径拼接（只处理 '..' 和 '.'） */
function pathJoin(dir: string, source: string): string {
  const parts = source.split('/')
  const dirParts = dir ? dir.split('/') : []

  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      dirParts.pop()
    } else {
      dirParts.push(part)
    }
  }

  return dirParts.join('/')
}

// ==================== 工具函数 ====================

/** 获取源码中指定索引的行号（从 1 开始） */
function getLine(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

/** 从源码中查找符号定义的行号（从 startLine 开始搜索） */
function findSymbolLine(source: string, name: string, startLine: number): number {
  const lines = source.split('\n')
  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i]!
    // 匹配 def name( / class name / name = / export.*name
    if (new RegExp(`\\b${escapeRegex(name)}\\b`).test(line)) {
      return i + 1
    }
  }
  return startLine
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
