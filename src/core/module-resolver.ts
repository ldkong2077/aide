/**
 * AIDE - 跨文件模块解析器
 * 构建项目级符号索引：哪些名称被其他文件引用
 *
 * 两遍扫描架构：
 *   第1遍：快速提取每个文件的 import/export，构建跨文件引用图
 *   第2遍：检测器使用 projectSymbols 判断符号是否被其他文件使用
 *
 * 设计原则：
 * - 第1遍只做轻量正则提取，不全量 AST 解析（性能优先）
 * - 解析失败 → 返回空索引，检测器降级
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ProjectSymbolIndex, Language } from '../types/index.js'

// ==================== 项目符号索引构建 ====================

/**
 * 第1遍扫描：从文件列表构建项目级符号索引。
 * 只做轻量正则提取，不全量 AST 解析。
 */
export function buildProjectSymbolIndex(
  files: Array<{ filePath: string; language: Language; source: string }>,
): ProjectSymbolIndex {
  const referencedAcrossFiles = new Set<string>()
  const exportsByFile = new Map<string, Set<string>>()
  const reExports = new Map<string, Set<string>>()

  // 收集每个文件的导出和导入
  const fileImports = new Map<string, Set<string>>()   // file -> imported names
  const fileExports = new Map<string, Set<string>>()     // file -> exported names

  for (const file of files) {
    const imports = new Set<string>()
    const exports = new Set<string>()

    switch (file.language) {
      case 'python':
        extractPythonImportsAndExports(file.source, imports, exports, reExports, file.filePath)
        break
      case 'typescript':
      case 'javascript':
        extractJSImportsAndExports(file.source, imports, exports)
        break
      case 'go':
        extractGoImportsAndExports(file.source, imports, exports)
        break
      case 'java':
        extractJavaImportsAndExports(file.source, imports, exports)
        break
      case 'rust':
        extractRustImportsAndExports(file.source, imports, exports)
        break
      case 'ruby':
        extractRubyImportsAndExports(file.source, imports, exports)
        break
    }

    fileImports.set(file.filePath, imports)
    fileExports.set(file.filePath, exports)
    exportsByFile.set(file.filePath, exports)
  }

  // 构建跨文件引用集合：如果一个名称在文件 A 中被 import，
  // 且在文件 B 中被 export，则该名称是跨文件引用的
  for (const [filePath, imports] of fileImports) {
    for (const name of imports) {
      referencedAcrossFiles.add(name)
    }
  }

  // 处理 __init__.py 重新导出：如果 __init__.py 导入了子模块的名称，
  // 那么这些名称也被视为跨文件引用
  for (const [initPath, reExportedNames] of reExports) {
    for (const name of reExportedNames) {
      referencedAcrossFiles.add(name)
    }
  }

  return { referencedAcrossFiles, exportsByFile, reExports }
}

// ==================== Python ====================

function extractPythonImportsAndExports(
  source: string,
  imports: Set<string>,
  exports: Set<string>,
  reExports: Map<string, Set<string>>,
  filePath: string,
): void {
  // import xxx
  const importRegex = /^import\s+(\w+)/gm
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(source)) !== null) {
    imports.add(match[1])
  }

  // from xxx import yyy
  const fromImportRegex = /^from\s+(\S+)\s+import\s+(.+)/gm
  while ((match = fromImportRegex.exec(source)) !== null) {
    const module = match[1]
    const names = match[2].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
    for (const name of names) {
      if (!name || name === '*' || !/^[a-zA-Z_]\w*$/.test(name)) continue
      imports.add(name)

      // __init__.py 中的 from .xxx import yyy 是重新导出
      if (filePath.endsWith('__init__.py') && module.startsWith('.')) {
        const reExportSet = reExports.get(filePath) || new Set<string>()
        reExportSet.add(name)
        reExports.set(filePath, reExportSet)
      }
    }
  }

  // Python 没有显式 export，模块级定义（函数/类/UPPER_CASE变量）都是潜在的导出
  // 提取模块级定义
  const lines = source.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('import') || trimmed.startsWith('from')) continue
    // 只看模块级（无缩进）
    if (line !== trimmed && !line.startsWith(trimmed)) continue

    // def xxx
    const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)/)
    if (funcMatch) {
      exports.add(funcMatch[1])
      continue
    }

    // class xxx
    const classMatch = trimmed.match(/^class\s+(\w+)/)
    if (classMatch) {
      exports.add(classMatch[1])
      continue
    }

    // UPPER_CASE = ... (常量)
    const constMatch = trimmed.match(/^([A-Z][A-Z_0-9]+)\s*=/)
    if (constMatch) {
      exports.add(constMatch[1])
      continue
    }

    // xxx: Type = ... (带类型注解的变量)
    const varMatch = trimmed.match(/^(\w+)\s*:\s*(?:str|int|float|bool|list|dict|set|tuple|Optional|List|Dict|Set|Tuple|Union|Any|None)/)
    if (varMatch && !/^(class|def|if|for|while|try|with|return|raise|import|from)\b/.test(varMatch[1])) {
      exports.add(varMatch[1])
    }
  }
}

// ==================== JavaScript/TypeScript ====================

function extractJSImportsAndExports(
  source: string,
  imports: Set<string>,
  exports: Set<string>,
): void {
  // import { xxx } from '...'
  const namedImportRegex = /import\s*\{([^}]+)\}\s*from\s+['"][^'"]+['"]/g
  let match: RegExpExecArray | null
  while ((match = namedImportRegex.exec(source)) !== null) {
    const bindings = match[1].split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/)
      return parts.length > 1 ? parts[1]!.trim() : parts[0]!.trim()
    })
    for (const name of bindings) {
      if (name && !name.startsWith('_')) imports.add(name)
    }
  }

  // import xxx from '...'
  const defaultImportRegex = /import\s+(\w+)\s+from\s+['"][^'"]+['"]/g
  while ((match = defaultImportRegex.exec(source)) !== null) {
    if (match[1] && !match[1].startsWith('_')) imports.add(match[1])
  }

  // import * as xxx from '...'
  const namespaceImportRegex = /import\s+\*\s+as\s+(\w+)\s+from\s+['"][^'"]+['"]/g
  while ((match = namespaceImportRegex.exec(source)) !== null) {
    if (match[1] && !match[1].startsWith('_')) imports.add(match[1])
  }

  // export function xxx / export class xxx / export const xxx
  const exportFuncRegex = /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g
  while ((match = exportFuncRegex.exec(source)) !== null) {
    exports.add(match[1])
  }

  const exportClassRegex = /export\s+(?:default\s+)?class\s+(\w+)/g
  while ((match = exportClassRegex.exec(source)) !== null) {
    exports.add(match[1])
  }

  const exportConstRegex = /export\s+(?:const|let|var|type|interface)\s+(\w+)/g
  while ((match = exportConstRegex.exec(source)) !== null) {
    exports.add(match[1])
  }

  // export { xxx, yyy }
  const exportListRegex = /export\s*\{([^}]+)\}/g
  while ((match = exportListRegex.exec(source)) !== null) {
    const names = match[1].split(',').map(s => {
      const parts = s.trim().split(/\s+as\s+/)
      return parts[0]!.trim()
    })
    for (const name of names) {
      if (name && !name.startsWith('_')) exports.add(name)
    }
  }
}

// ==================== Go ====================

function extractGoImportsAndExports(
  source: string,
  imports: Set<string>,
  exports: Set<string>,
): void {
  // Go 的 import 是包路径，不是符号名
  // 导出是首字母大写，在 extractExports 中处理

  // 提取函数名（首字母大写 = 导出）
  const funcRegex = /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/gm
  let match: RegExpExecArray | null
  while ((match = funcRegex.exec(source)) !== null) {
    const name = match[1]
    if (name && /^[A-Z]/.test(name)) {
      exports.add(name)
    }
    // Go 中引用其他包的导出符号: pkg.FuncName
    // 这里简单收集所有标识符
    imports.add(name)
  }

  // 提取类型名
  const typeRegex = /^type\s+(\w+)\s+/gm
  while ((match = typeRegex.exec(source)) !== null) {
    const name = match[1]
    if (name && /^[A-Z]/.test(name)) {
      exports.add(name)
    }
  }
}

// ==================== Java ====================

function extractJavaImportsAndExports(
  source: string,
  imports: Set<string>,
  exports: Set<string>,
): void {
  // import xxx.yyy.ClassName
  const importRegex = /import\s+(?:static\s+)?[\w.]+\.(\w+)\s*;/g
  let match: RegExpExecArray | null
  while ((match = importRegex.exec(source)) !== null) {
    imports.add(match[1])
  }

  // public class/method 是导出
  const classRegex = /(?:public|protected)\s+(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/g
  while ((match = classRegex.exec(source)) !== null) {
    exports.add(match[1])
  }

  const methodRegex = /public\s+(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g
  while ((match = methodRegex.exec(source)) !== null) {
    if (!/^(if|for|while|switch|catch)\b/.test(match[1])) {
      exports.add(match[1])
    }
  }
}

// ==================== Rust ====================

function extractRustImportsAndExports(
  source: string,
  imports: Set<string>,
  exports: Set<string>,
): void {
  // use xxx::yyy
  const useRegex = /use\s+[\w:]+::(\w+)/g
  let match: RegExpExecArray | null
  while ((match = useRegex.exec(source)) !== null) {
    imports.add(match[1])
  }

  // pub fn / pub struct / pub enum
  const pubFnRegex = /pub\s+(?:async\s+)?fn\s+(\w+)/g
  while ((match = pubFnRegex.exec(source)) !== null) {
    exports.add(match[1])
  }

  const pubStructRegex = /pub\s+struct\s+(\w+)/g
  while ((match = pubStructRegex.exec(source)) !== null) {
    exports.add(match[1])
  }

  const pubEnumRegex = /pub\s+enum\s+(\w+)/g
  while ((match = pubEnumRegex.exec(source)) !== null) {
    exports.add(match[1])
  }
}

// ==================== Ruby ====================

function extractRubyImportsAndExports(
  source: string,
  imports: Set<string>,
  exports: Set<string>,
): void {
  // require / require_relative 'xxx'
  const requireRegex = /require(?:_relative)?\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = requireRegex.exec(source)) !== null) {
    // Ruby require 用路径，取最后一段作为模块名
    const name = match[1].split('/').pop()!
    imports.add(name)
  }

  // class / module 定义
  const classRegex = /^class\s+(\w+)/gm
  while ((match = classRegex.exec(source)) !== null) {
    exports.add(match[1])
  }

  const moduleRegex = /^module\s+(\w+)/gm
  while ((match = moduleRegex.exec(source)) !== null) {
    exports.add(match[1])
  }

  // def 方法（包括缩进在 class 内的）
  const methodRegex = /^\s*def\s+(?:self\.)?(\w+)/gm
  while ((match = methodRegex.exec(source)) !== null) {
    exports.add(match[1])
  }
}
