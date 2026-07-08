/**
 * AIDE - 公共工具函数
 * 统一各检测器重复实现的通用方法
 */

/**
 * 根据字符索引计算行号（1-based）
 * 与各检测器中私有 getLineNumber 方法功能相同
 */
export function getLineNumber(code: string, index: number): number {
  return code.substring(0, index).split('\n').length
}

/**
 * 转义正则表达式特殊字符
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 提取花括号块内的内容
 * 先将字符串和注释中的花括号替换为空格，避免误判函数体边界
 *
 * @param source 完整源码
 * @param startBraceIndex 起始花括号 `{` 的索引位置
 * @returns 花括号块内的内容（不含外层花括号），或 null（未找到匹配）
 */
export function extractBlockBody(source: string, startBraceIndex: number): string | null {
  const cleaned = stripStringAndCommentBraces(source)

  let depth = 0
  let i = startBraceIndex
  const start = startBraceIndex

  while (i < cleaned.length) {
    if (cleaned[i] === '{') depth++
    else if (cleaned[i] === '}') depth--
    i++
    if (depth === 0) break
  }

  if (depth !== 0) return null
  // 返回原始源码的花括号块内内容（不含外层花括号）
  return source.substring(start + 1, i - 1)
}

/**
 * 将字符串和注释中的花括号替换为空格
 * 避免花括号计数被字符串/注释中的 `{` 干扰
 */
export function stripStringAndCommentBraces(source: string): string {
  const chars = source.split('')
  let i = 0
  while (i < chars.length) {
    // 单行注释 //
    if (chars[i] === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n') {
        if (chars[i] === '{' || chars[i] === '}') chars[i] = ' '
        i++
      }
      continue
    }
    // 块注释 /* ... */
    if (chars[i] === '/' && chars[i + 1] === '*') {
      i += 2
      while (i < chars.length - 1 && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] === '{' || chars[i] === '}') chars[i] = ' '
        i++
      }
      i += 2
      continue
    }
    // 双引号字符串
    if (chars[i] === '"') {
      i++
      while (i < chars.length && chars[i] !== '"' && chars[i - 1] !== '\\') {
        if (chars[i] === '{' || chars[i] === '}') chars[i] = ' '
        i++
      }
      i++
      continue
    }
    // 单引号字符串
    if (chars[i] === "'") {
      i++
      while (i < chars.length && chars[i] !== "'" && chars[i - 1] !== '\\') {
        if (chars[i] === '{' || chars[i] === '}') chars[i] = ' '
        i++
      }
      i++
      continue
    }
    // 模板字符串 `...`
    if (chars[i] === '`') {
      i++
      while (i < chars.length && chars[i] !== '`') {
        if (chars[i] === '{' || chars[i] === '}') chars[i] = ' '
        if (chars[i] === '\\' && i + 1 < chars.length) i++
        i++
      }
      i++
      continue
    }
    // Python 三引号
    if (chars[i] === '"' && chars[i + 1] === '"' && chars[i + 2] === '"') {
      i += 3
      while (i < chars.length - 2 && !(chars[i] === '"' && chars[i + 1] === '"' && chars[i + 2] === '"')) {
        if (chars[i] === '{' || chars[i] === '}') chars[i] = ' '
        i++
      }
      i += 3
      continue
    }
    // Python # 注释
    if (chars[i] === '#') {
      while (i < chars.length && chars[i] !== '\n') {
        if (chars[i] === '{' || chars[i] === '}') chars[i] = ' '
        i++
      }
      continue
    }
    i++
  }
  return chars.join('')
}

/**
 * 判断源码中指定位置是否处于"非代码上下文"
 * （字符串字面量、正则字面量、注释）
 *
 * 检测器匹配到某位置后，可调用此函数排除字符串/注释/正则中的误匹配，
 * 例如 `const msg = "请勿使用 eval()"` 中的 eval 不应被标记为安全问题。
 *
 * 支持的上下文类型：
 * - JS/TS 行注释 //、块注释 /* *‍/
 * - Python 行注释 #
 * - 单/双/反引号字符串
 * - Python 三引号字符串
 * - JS/TS 正则字面量 /pattern/flags
 *
 * @param code  完整源码
 * @param index 要检查的字符索引
 * @returns true 表示该位置在字符串、正则或注释中
 */
export function isInNonCode(code: string, index: number): boolean {
  let i = 0

  while (i <= index) {
    const c = code[i]

    // --- 跳过注释（注释本身也是非代码，直接跳过并继续扫描） ---

    // JS/TS 行注释
    if (c === '/' && code[i + 1] === '/') {
      i += 2
      while (i < code.length && code[i] !== '\n') i++
      if (i > index) return true
      continue
    }

    // JS/TS 块注释
    if (c === '/' && code[i + 1] === '*') {
      i += 2
      while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      if (i > index) return true
      continue
    }

    // Python # 行注释
    if (c === '#') {
      while (i < code.length && code[i] !== '\n') i++
      if (i > index) return true
      continue
    }

    // --- 字符串字面量 ---

    // Python 三双引号 """..."""
    if (c === '"' && code[i + 1] === '"' && code[i + 2] === '"') {
      i += 3
      while (i < code.length - 2) {
        if (code[i] === '"' && code[i + 1] === '"' && code[i + 2] === '"') { i += 3; break }
        if (code[i] === '\\' && i + 1 < code.length) i++
        i++
      }
      if (i > index) return true
      continue
    }

    // Python 三单引号 '''...'''
    if (c === "'" && code[i + 1] === "'" && code[i + 2] === "'") {
      i += 3
      while (i < code.length - 2) {
        if (code[i] === "'" && code[i + 1] === "'" && code[i + 2] === "'") { i += 3; break }
        if (code[i] === '\\' && i + 1 < code.length) i++
        i++
      }
      if (i > index) return true
      continue
    }

    // 双引号字符串 "..."
    if (c === '"') {
      i++
      while (i < code.length && code[i] !== '"' && code[i] !== '\n') {
        if (code[i] === '\\' && i + 1 < code.length) i++
        i++
      }
      i++ // 跳过闭合引号
      if (i > index) return true
      continue
    }

    // 单引号字符串 '...'
    if (c === "'") {
      i++
      while (i < code.length && code[i] !== "'" && code[i] !== '\n') {
        if (code[i] === '\\' && i + 1 < code.length) i++
        i++
      }
      i++ // 跳过闭合引号
      if (i > index) return true
      continue
    }

    // 模板字符串 `...`
    if (c === '`') {
      i++
      while (i < code.length && code[i] !== '`') {
        if (code[i] === '\\' && i + 1 < code.length) { i += 2; continue }
        // ${...} 表达式中的代码是真实代码，只跳过字符串部分
        if (code[i] === '$' && code[i + 1] === '{') {
          i += 2
          let depth = 1
          while (i < code.length && depth > 0) {
            if (code[i] === '{') depth++
            else if (code[i] === '}') depth--
            i++
          }
          continue
        }
        i++
      }
      i++ // 跳过闭合反引号
      if (i > index) return true
      continue
    }

    // --- JS/TS 正则字面量 /pattern/flags ---

    if (c === '/' && isRegexStart(code, i)) {
      i++ // 跳过开头 /
      while (i < code.length && code[i] !== '/') {
        if (code[i] === '\\' && i + 1 < code.length) { i += 2; continue }
        // 字符类 [...]
        if (code[i] === '[') {
          i++
          while (i < code.length && code[i] !== ']') {
            if (code[i] === '\\' && i + 1 < code.length) i++
            i++
          }
          if (i < code.length) i++ // 跳过 ]
        } else {
          i++
        }
      }
      if (i < code.length) i++ // 跳过闭合 /
      // 跳过正则标志位
      while (i < code.length && /[gimsuy]/.test(code[i])) i++
      if (i > index) return true
      continue
    }

    i++
  }

  return false
}

/**
 * 判断源码中指定位置是否在注释中（行注释或块注释）
 *
 * 与 isInNonCode 不同，此函数只跳过注释，不跳过字符串字面量。
 * 适用于需要匹配字符串内容的检测器（如硬编码密钥检测）：
 * 密钥值本身就在字符串中（`const key = "sk-..."`），不能跳过字符串。
 *
 * @param code  完整源码
 * @param index 要检查的字符索引
 * @returns true 表示该位置在注释中
 */
export function isInComment(code: string, index: number): boolean {
  let i = 0

  while (i <= index) {
    const c = code[i]

    // JS/TS 行注释
    if (c === '/' && code[i + 1] === '/') {
      i += 2
      while (i < code.length && code[i] !== '\n') i++
      if (i > index) return true
      continue
    }

    // JS/TS 块注释
    if (c === '/' && code[i + 1] === '*') {
      i += 2
      while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++
      i += 2
      if (i > index) return true
      continue
    }

    // Python # 行注释
    if (c === '#') {
      while (i < code.length && code[i] !== '\n') i++
      if (i > index) return true
      continue
    }

    i++
  }

  return false
}

/**
 * 启发式判断 '/' 是否为正则字面量的开头
 * 在标识符、数字、) ] 之后 '/' 是除法运算符
 * 在 = ( [ ! & | ? { } ; : 等之后 '/' 是正则开头
 */
function isRegexStart(code: string, slashIndex: number): boolean {
  let j = slashIndex - 1
  while (j >= 0 && /\s/.test(code[j])) j--
  if (j < 0) return true // 文件开头

  const prev = code[j]

  // ++ / -- 之后 '/' 大概率是除法
  if ((prev === '+' || prev === '-') && j > 0 && code[j - 1] === prev) return false

  // 这些字符之后 '/' 是正则
  if ('=([!&|?{};:,~^%<>'.includes(prev)) return true

  // 标识符、数字、) ] 之后 '/' 是除法
  if (/[)\]a-zA-Z0-9_]/.test(prev)) return false

  // 默认视为正则（宁可多跳过也不误报）
  return true
}
