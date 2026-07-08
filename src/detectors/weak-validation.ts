/**
 * AIDE - 弱输入验证检测器
 * 检测函数参数只做简单空值检查而未验证空字符串、空对象、嵌套结构的情况
 */

import { isTestFile } from '../types/index.js'
import { getLineNumber, extractBlockBody } from '../core/utils.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'

/** Schema 验证库模式 */
const SCHEMA_LIBRARIES = /\b(?:joi|zod|pydantic|valibot|yup|ajv|joi\.object|z\.object|schema\.validate|BaseModel)\b/

/** 弱验证模式（JS/TS） */
const WEAK_VALIDATION_JS = [
  /\bif\s*\(\s*!data\s*\)/,                          // if (!data)
  /\bif\s*\(\s*data\s*===\s*null\s*\)/,              // if (data === null)
  /\bif\s*\(\s*data\s*===\s*undefined\s*\)/,         // if (data === undefined)
  /\bif\s*\(\s*data\s*==\s*null\s*\)/,               // if (data == null)
  /\bif\s*\(\s*data\s*==\s*undefined\s*\)/,           // if (data == undefined)
  /\bif\s*\(\s*!param\s*\)/,                          // if (!param)
  /\bif\s*\(\s*param\s*===\s*null\s*\)/,              // if (param === null)
  /\bif\s*\(\s*param\s*===\s*undefined\s*\)/,         // if (param === undefined)
]

/** 弱验证模式（Python） */
const WEAK_VALIDATION_PYTHON = [
  /\bif\s+not\s+data\s*:/,                            // if not data:
  /\bif\s+data\s+is\s+None\s*:/,                      // if data is None:
  /\bif\s+not\s+param\s*:/,                           // if not param:
  /\bif\s+param\s+is\s+None\s*:/,                     // if param is None:
]

/** 强验证模式（表示有更完善的验证） */
const STRONG_VALIDATION_JS = [
  /\.length\s*(?:>|<|>=|<=|===)\s*\d/,                // data.length > 0
  /\.trim\(\)/,                                        // data.trim()
  /typeof\s+\w+\s*===?\s*['"]string['"]/,             // typeof data === 'string'
  /Object\.keys\(/,                                    // Object.keys(data)
  /Array\.isArray\(/,                                  // Array.isArray(data)
  /\.every\(/,                                         // data.every(...)
  /\.some\(/,                                          // data.some(...)
  /instanceof\s+\w/,                                   // data instanceof ...
  /\bisEmpty\(/,                                       // isEmpty(data)
  /\bhasOwnProperty\(/,                                // hasOwnProperty
  /\bin\s+\w+\./,                                      // 嵌套属性访问检查
]

const STRONG_VALIDATION_PYTHON = [
  /\.strip\(\)/,                                       // data.strip()
  /len\(\w+\)\s*(?:>|<|>=|<=|==)\s*\d/,               // len(data) > 0
  /isinstance\(\w+,\s*\w+\)/,                          // isinstance(data, ...)
  /hasattr\(\w+,\s*['"]/,                              // hasattr(data, '...')
  /\btype\(\w+\)\s*is\s*/,                             // type(data) is ...
]

/** 弱验证模式（Java） */
const WEAK_VALIDATION_JAVA = [
  /\bif\s*\(\s*data\s*==\s*null\s*\)/,              // if (data == null)
  /\bif\s*\(\s*param\s*==\s*null\s*\)/,              // if (param == null)
  /\bif\s*\(\s*\w+\s*==\s*null\s*\)/,                // if (xxx == null)
  /\bif\s*\(\s*\w+\s*!=\s*null\s*\)/,                // if (xxx != null)
  /\bif\s*\(\s*\w+\.isEmpty\s*\(\s*\)\s*\)/,         // if (xxx.isEmpty())
]

/** 强验证模式（Java） */
const STRONG_VALIDATION_JAVA = [
  /\.matches\s*\(/,                                    // regex.matches()
  /\.length\s*\(\s*\)\s*(?:>|<|>=|<=|==)\s*\d/,       // xxx.length() > 0
  /Pattern\./,                                         // Pattern.compile
  /Validator\./,                                       // Validator.validate
  /@Valid/,                                            // Bean Validation
  /@NotNull/,                                          // @NotNull annotation
  /@NotEmpty/,                                         // @NotEmpty annotation
  /@NotBlank/,                                         // @NotBlank annotation
]

/** 弱验证模式（Go） */
const WEAK_VALIDATION_GO = [
  /\bif\s+\w+\s*==\s*nil\s*\{/,                       // if xxx == nil {
  /\bif\s+\w+\s*!=\s*nil\s*\{/,                       // if xxx != nil {
  /\bif\s+len\s*\(\s*\w+\s*\)\s*==\s*0\s*\{/,        // if len(xxx) == 0 {
]

/** 强验证模式（Go） */
const STRONG_VALIDATION_GO = [
  /regexp\./,                                          // regexp.Match / regexp.Compile
  /validator\./,                                       // validator.Var / validator.Struct
  /len\s*\(\s*\w+\s*\)\s*(?:>|<|>=|<=)\s*\d/,         // len(xxx) > 0 (not just == 0)
  /strings\.\w+\s*\(/,                                 // strings.Contains etc.
]

export class WeakValidationDetector implements Detector {
  rule = 'weak-validation'
  category = 'ai-code' as const
  description = '检测弱输入验证（仅检查 null/undefined 而未验证空值和结构）'
  severity = 'medium' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    switch (language) {
      case 'typescript':
      case 'javascript':
        return this.detectJS(source, filePath)
      case 'python':
        return this.detectPython(source, filePath)
      case 'java':
        return this.detectJava(source, filePath)
      case 'go':
        return this.detectGo(source, filePath)
      default:
        return []
    }
  }

  private detectJS(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配函数声明
    const funcRegex = /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{)|(?:(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=]+)?\s*=>\s*\{)/g

    let match: RegExpExecArray | null

    while ((match = funcRegex.exec(source)) !== null) {
      const name = match[1] || match[3]
      const params = match[2] || match[4]

      if (!name || !params) continue

      // 跳过 TypeScript 中参数有类型注解的函数
      if (this.hasTypeAnnotations(params)) continue

      // 获取函数体
      const bodyStart = source.indexOf('{', match.index) + 1
      const body = extractBlockBody(source, bodyStart)
      if (!body) continue

      // 跳过有 schema 验证的函数
      if (SCHEMA_LIBRARIES.test(body)) continue

      // 检查弱验证
      if (this.hasWeakValidation(body, 'js') && !this.hasStrongValidation(body, 'js')) {
        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'ai-code',
          file: filePath,
          line: getLineNumber(source, match.index),
          message: `函数 "${name}" 的输入验证过于简单，仅检查空值而未验证空字符串、空对象或嵌套结构`,
          snippet: `${name}(${params.split(',').map(p => p.trim()).join(', ')})`,
          suggestion: '请添加更完善的输入验证：检查空字符串、空数组、嵌套属性，或使用 schema 验证库（如 zod、joi、valibot）',
        })
      }
    }

    return issues
  }

  private detectPython(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配函数声明
    const funcRegex = /^(\s*)def\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*[^=]+)?\s*:\s*\n((?:\1\s+.*\n)*)/gm

    let match: RegExpExecArray | null

    while ((match = funcRegex.exec(source)) !== null) {
      const name = match[2]
      const params = match[3]

      if (!params.trim()) continue

      // 跳过 __init__ 和 dunder 方法
      if (name.startsWith('__') && name.endsWith('__')) continue

      const body = match[4]

      // 跳过有 schema 验证的函数（pydantic BaseMode 等）
      if (SCHEMA_LIBRARIES.test(body)) continue

      // 检查弱验证
      if (this.hasWeakValidation(body, 'python') && !this.hasStrongValidation(body, 'python')) {
        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'ai-code',
          file: filePath,
          line: getLineNumber(source, match.index),
          message: `函数 "${name}" 的输入验证过于简单，仅检查 None 而未验证空值和结构`,
          snippet: `def ${name}(${params.split(',').map(p => p.trim()).join(', ')})`,
          suggestion: '请添加更完善的输入验证：检查空字符串、空列表、嵌套属性，或使用 pydantic 进行 schema 验证',
        })
      }
    }

    return issues
  }

  /** 弱验证检测（Java） */
  private detectJava(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配 Java 方法
    const methodRegex = /(?:public|private|protected)?\s*(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g

    let match: RegExpExecArray | null
    while ((match = methodRegex.exec(source)) !== null) {
      const name = match[1]
      const params = match[2]

      if (!params.trim()) continue
      // 跳过构造函数
      const before = source.substring(Math.max(0, match.index - 500), match.index)
      const classMatch = /class\s+(\w+)/.exec(before)
      if (classMatch && classMatch[1] === name) continue

      const bodyStart = source.indexOf('{', match.index) + 1
      const body = extractBlockBody(source, bodyStart)
      if (!body) continue

      if (WEAK_VALIDATION_JAVA.some(p => p.test(body))
          && !STRONG_VALIDATION_JAVA.some(p => p.test(body))) {
        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'ai-code',
          file: filePath,
          line: getLineNumber(source, match.index),
          message: `Java 方法 "${name}" 的输入验证过于简单，仅检查 null 而未验证空值和结构`,
          snippet: `${name}(${params.split(',').map(p => p.trim()).join(', ')})`,
          suggestion: '请添加更完善的输入验证：使用 @Valid 注解、正则匹配、或自定义 Validator',
        })
      }
    }

    return issues
  }

  /** 弱验证检测（Go） */
  private detectGo(source: string, filePath: string): Issue[] {
    const issues: Issue[] = []

    // 匹配 Go 函数
    const funcRegex = /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:\([^)]*\))?\s*\{/g

    let match: RegExpExecArray | null
    while ((match = funcRegex.exec(source)) !== null) {
      const name = match[1]
      const params = match[2]

      if (!params.trim()) continue
      if (name === 'init' || name === 'main') continue

      const bodyStart = source.indexOf('{', match.index) + 1
      const body = extractBlockBody(source, bodyStart)
      if (!body) continue

      if (WEAK_VALIDATION_GO.some(p => p.test(body))
          && !STRONG_VALIDATION_GO.some(p => p.test(body))) {
        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'ai-code',
          file: filePath,
          line: getLineNumber(source, match.index),
          message: `Go 函数 "${name}" 的输入验证过于简单，仅检查 nil 而未验证空值和结构`,
          snippet: `func ${name}(${params.split(',').map(p => p.trim()).join(', ')})`,
          suggestion: '请添加更完善的输入验证：使用正则匹配、长度检查、或 validator 库',
        })
      }
    }

    return issues
  }

  /** 检查参数是否有 TypeScript 类型注解 */
  private hasTypeAnnotations(params: string): boolean {
    // 检查是否有 param: Type 格式的类型注解
    const paramList = params.split(',')
    return paramList.some(p => {
      const trimmed = p.trim()
      // 排除只有类型没有名字的情况，和 rest 参数
      if (!trimmed || trimmed.startsWith('...')) return false
      // 检查是否有冒号（类型注解）
      return /:\s*\w/.test(trimmed)
    })
  }

  /** 检查是否有弱验证模式 */
  private hasWeakValidation(body: string, lang: 'js' | 'python'): boolean {
    const patterns = lang === 'js' ? WEAK_VALIDATION_JS : WEAK_VALIDATION_PYTHON
    return patterns.some(p => p.test(body))
  }

  /** 检查是否有强验证模式 */
  private hasStrongValidation(body: string, lang: 'js' | 'python'): boolean {
    const patterns = lang === 'js' ? STRONG_VALIDATION_JS : STRONG_VALIDATION_PYTHON
    return patterns.some(p => p.test(body))
  }
}
