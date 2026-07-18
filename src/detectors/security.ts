/**
 * AIDE - 安全模式检测器
 * 检测硬编码密钥、SQL 注入、XSS、命令注入等安全问题
 */

import { isTestFile } from '../types/index.js'
import { getLineNumber, isInNonCode, isInComment } from '../core/utils.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'

export class SecurityDetector implements Detector {
  rule = 'security'
  category = 'security' as const
  description = '检测硬编码密钥、SQL 注入、XSS、命令注入等安全问题'
  severity = 'high' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath } = ctx
    const issues: Issue[] = []

    // 跳过测试文件
    if (isTestFile(filePath)) return issues

    this.checkHardcodedSecrets(source, language, filePath, issues)
    this.checkSQLInjection(source, language, filePath, issues)
    this.checkXSS(source, language, filePath, issues)
    this.checkCommandInjection(source, language, filePath, issues)
    this.checkEvalUsage(source, language, filePath, issues)
    this.checkInsecureHTTP(source, language, filePath, issues)
    this.checkAISpecificSecurity(source, language, filePath, issues)

    return issues
  }

  /** 检测硬编码密钥/Token */
  private checkHardcodedSecrets(code: string, language: string, filePath: string, issues: Issue[]): void {
    const secretPatterns = [
      // API Key 模式
      { regex: /['"`](sk-[a-zA-Z0-9]{20,})['"`]/g, name: 'OpenAI API Key' },
      { regex: /['"`](ghp_[a-zA-Z0-9]{36})['"`]/g, name: 'GitHub Personal Access Token' },
      { regex: /['"`](gho_[a-zA-Z0-9]{36})['"`]/g, name: 'GitHub OAuth Token' },
      { regex: /['"`](AKIA[A-Z0-9]{16})['"`]/g, name: 'AWS Access Key ID' },
      { regex: /['"`](AIza[a-zA-Z0-9_-]{35})['"`]/g, name: 'Google API Key' },
      // 通用密钥模式
      { regex: /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"`]([^'"`]{8,})['"`]/gi, name: '硬编码密钥' },
      { regex: /(?:password|passwd|pwd)\s*[:=]\s*['"`]([^'"`]{3,})['"`]/gi, name: '硬编码密码' },
    ]

    for (const { regex, name } of secretPatterns) {
      let match
      while ((match = regex.exec(code)) !== null) {
        const line = getLineNumber(code, match.index!)

        // 跳过注释中的匹配（密钥值本身在字符串中，不能用 isInNonCode）
        if (isInComment(code, match.index)) continue

        // 跳过占位符
        const value = match[1] || match[0]
        if (this.isPlaceholder(value)) continue

        // 跳过枚举/常量标识符（key 和 value 本质相同，如 RESET_PASSWORD: 'reset_password'）
        if (this.isEnumIdentifier(match[0], value)) continue

        issues.push({
          rule: this.rule,
          severity: 'high',
          category: 'security',
          file: filePath,
          line,
          message: `${name}: "${value.substring(0, 20)}${value.length > 20 ? '...' : ''}"`,
          snippet: match[0].length > 80 ? match[0].substring(0, 80) + '...' : match[0].trim(),
          suggestion: '使用环境变量存储密钥，如 process.env.API_KEY',
        })
      }
    }
  }

  /** 检测 SQL 注入风险 */
  private checkSQLInjection(code: string, language: string, filePath: string, issues: Issue[]): void {
    const sqlPatterns: { regex: RegExp; message: string }[] = []

    if (language === 'python') {
      // 优化：区分 f-string 和参数化查询
      // f-string: cursor.execute(f"SELECT * FROM {table}") - 不安全
      // 参数化查询: cursor.execute("SELECT * FROM users WHERE username = %s", (username,)) - 安全
      sqlPatterns.push({
        // 匹配 f-string 中的变量插值（最危险的情况）
        regex: /(?:execute|cursor\.execute)\s*\(\s*f['"][^'"]*\{[^}]+\}/g,
        message: 'SQL 注入风险：f-string 中包含变量插值',
      })
      sqlPatterns.push({
        // 匹配字符串拼接（不安全）
        regex: /(?:execute|cursor\.execute)\s*\(\s*['"][^'"]*\+\s*\w+/g,
        message: 'SQL 注入风险：使用字符串拼接构建 SQL',
      })
      // 注意：不再匹配 %s 占位符，因为那是参数化查询的标志
    } else {
      sqlPatterns.push({
        regex: /(?:execute|query)\s*\(\s*(?:`[^`]*\$\{|'[^']*'\s*\+\s*\w+|"[^"]*"\s*\+\s*\w+)/g,
        message: 'SQL 注入风险：使用字符串拼接构建 SQL',
      })
    }

    for (const { regex, message } of sqlPatterns) {
      let match
      while ((match = regex.exec(code)) !== null) {
        const line = getLineNumber(code, match.index!)

        // 跳过字符串/注释/正则中的匹配
        if (isInNonCode(code, match.index!)) continue

        // 跳过迁移脚本中的硬编码表名查询
        if (/migrat|schema|fixture|seed/i.test(filePath)) continue

        issues.push({
          rule: this.rule,
          severity: 'high',
          category: 'security',
          file: filePath,
          line,
          message,
          snippet: match[0].trim(),
          suggestion: '使用参数化查询，如 db.query("SELECT * FROM users WHERE id = ?", [userId])',
        })
      }
    }
  }

  /** 检测 XSS 风险 */
  private checkXSS(code: string, language: string, filePath: string, issues: Issue[]): void {
    // ===== 1. 扫描净化函数区域 =====
    // 收集所有已知净化函数的调用所在行 → 这些行的 innerHTML 赋值是安全的
    const sanitizedLines = new Set<number>()

    // 1a. 匹配已知净化库调用: innerHTML = DOMPurify.sanitize(...)
    const sanitizerCalls = [
      /DOMPurify\.sanitize\s*\(/g,
      /xss\s*\(/g,                             // js-xss 库
      /sanitizeHtml\s*\(/g,                    // sanitize-html 库
      /escapeHtml\s*\(/g,
      /escape\s*\(/g,                           // lodash escape / _.escape
      /purify\s*\(/g,
      /sanitize\s*\(/g,
      /validator\.escape\s*\(/g,                // express-validator
      /marked\s*\(/g,                           // marked 自带转义
      /safeMarkdown\s*\(/g,                     // 自定义 Markdown 净化
      /safeHTML\s*\(/g,                         // 自定义 HTML 净化
      /showdown\s*\(/g,                         // showdown Markdown 转换器（自带转义）
      /xss\.clean\s*\(/g,                       // xss 库的 clean 方法
      /createDOMPurify\s*\(/g,                  // DOMPurify 工厂模式
    ]

    for (const regex of sanitizerCalls) {
      let match
      while ((match = regex.exec(code)) !== null) {
        // 标记调用行
        sanitizedLines.add(getLineNumber(code, match.index!))
        // 同时标记同一行前面的 innerHTML 赋值（如果有）
        const lineStart = code.lastIndexOf('\n', match.index) + 1
        const lineBefore = code.slice(lineStart, match.index)
        if (/\.innerHTML\s*=\s*$/.test(lineBefore)) {
          sanitizedLines.add(getLineNumber(code, lineStart))
        }
      }
    }

    // 1b. 查找自定义净化函数定义（函数名含 sanitize/escape/purify/clean/safe/render/mark/html/strip/encode）
    const sanitizeFuncRegex = /(?:function|const|let|var)\s+(sanitize\w*|escape\w*|purify\w*|clean\w*|safe\w*|render\w*|mark\w*|html\w*|strip\w*|encode\w*)\s*(?:=|\(|\s*=>)/gi
    let funcMatch
    while ((funcMatch = sanitizeFuncRegex.exec(code)) !== null) {
      const funcName = funcMatch[1]
      // 扫描该函数的调用，标记调用行为安全
      const callRegex = new RegExp(`${funcName}\\s*\\(`, 'g')
      let callMatch
      while ((callMatch = callRegex.exec(code)) !== null) {
        sanitizedLines.add(getLineNumber(code, callMatch.index!))
      }
    }

    // 1c. 查找常见安全框架的转义输出（React JSX 中 {data} 自动转义）
    // 在 .tsx/.jsx 文件中，JSX 表达式 {expr} 自动转义 HTML，只有 dangerouslySetInnerHTML 需要检查
    const isJSX = /\.tsx$|\.jsx$|\.tsx\.test|\.jsx\.test/i.test(filePath)
    // 在 JSX 文件中，只在函数/方法内部检查 innerHTML，跳过模块顶层（通常是静态 HTML 模板）
    // 通过检查 .tsx 文件中的 innerHTML 是否在函数内部

    // ===== 2. 执行 XSS 检测 =====
    const xssPatterns: Array<{ regex: RegExp; message: string; marker?: string }> = [
      // 排除 innerHTML = '' (清空) 和 innerHTML = '<static html' 的情况
      { regex: /\.innerHTML\s*=\s*(?![\s]*['"`]<)(?![\s]*['"]?\s*['"]?\s*$)/g, message: 'XSS 风险：直接设置 innerHTML' },
      { regex: /document\.write\s*\(/g, message: 'XSS 风险：使用 document.write()' },
      { regex: /v-html\s*=\s*['"`]([^'"`]+)/g, message: 'XSS 风险：使用 v-html 绑定' },
    ]

    for (const { regex, message } of xssPatterns) {
      let match
      while ((match = regex.exec(code)) !== null) {
        const line = getLineNumber(code, match.index!)

        // 跳过字符串/注释/正则中的匹配
        if (isInNonCode(code, match.index)) continue

        // 跳过净化行：检查 innerHTML 右侧是否为净化调用
        if (sanitizedLines.has(line)) continue

        // 额外检查：提取 innerHTML 赋值右侧，看是否直接调用净化函数
        if (/\.innerHTML\s*=/.test(match[0])) {
          const lineStart = code.lastIndexOf('\n', match.index) + 1
          const lineEnd = code.indexOf('\n', match.index)
          const fullLine = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd).trim()
          // 检查同一行是否包含净化调用
          const hasSanitizer = sanitizerCalls.some(regex => {
            regex.lastIndex = 0
            return regex.test(fullLine)
          })
          if (hasSanitizer) continue
        }

        issues.push({
          rule: this.rule,
          // 无外部输入特征的 innerHTML 降级为 low（模板字面量拼接内部数据不是真正的 XSS 风险）
          severity: this.isExternalInputInnerHTML(code, match.index) ? 'high' : 'low',
          category: 'security',
          file: filePath,
          line,
          message,
          snippet: match[0].trim(),
          suggestion: '对用户输入进行 HTML 转义，或使用 textContent 代替 innerHTML',
        })
      }
    }

    // ===== 3. dangerouslySetInnerHTML 单独处理（React） =====
    // 在 JSX 文件中，dangerouslySetInnerHTML 即使配合净化函数也建议审查，
    // 因为它是 React 明确标记为危险的设计
    const diyRegex = /dangerouslySetInnerHTML\s*=\s*\{/g
    let diyMatch
    while ((diyMatch = diyRegex.exec(code)) !== null) {
      const line = getLineNumber(code, diyMatch.index!)

      // 跳过字符串/注释/正则中的匹配
      if (isInNonCode(code, diyMatch.index)) continue

      // 检查值中是否包含 __html: sanitizedValue
      const blockStart = diyMatch.index
      const snippet = code.slice(blockStart, blockStart + 120)
      // 如果有 DOMPurify 或 sanitize 调用，降级为 medium
      const hasSanitizer = /DOMPurify\.sanitize|sanitize|purify|escape/i.test(snippet)
      issues.push({
        rule: this.rule,
        severity: hasSanitizer ? 'medium' : 'high',
        category: 'security',
        file: filePath,
        line,
        message: '使用 dangerouslySetInnerHTML',
        snippet: diyMatch[0].trim(),
        suggestion: hasSanitizer
          ? '建议改用 React 组件代替 dangerouslySetInnerHTML，或确认净化的输入来源可信'
          : '避免使用 dangerouslySetInnerHTML，优先使用 React 组件渲染',
      })
    }
  }

  /** 检测命令注入 */
  private checkCommandInjection(code: string, language: string, filePath: string, issues: Issue[]): void {
    const cmdPatterns: { regex: RegExp; message: string }[] = []

    if (language === 'python') {
      cmdPatterns.push({
        regex: /(?:os\.system|subprocess\.(?:call|run|Popen))\s*\(\s*(?:f['"]|['"][^'"]*\+\s*\w+|['"][^'"]*%[sd])/g,
        message: '命令注入风险：使用字符串拼接构建 shell 命令',
      })
    } else {
      cmdPatterns.push({
        regex: /(?:exec|execSync|spawn|execFile)\s*\(\s*(?:`[^`]*\$\{|'[^']*'\s*\+\s*\w+|"[^"]*"\s*\+\s*\w+)/g,
        message: '命令注入风险：使用字符串拼接构建 shell 命令',
      })
    }

    for (const { regex, message } of cmdPatterns) {
      let match
      while ((match = regex.exec(code)) !== null) {
        const line = getLineNumber(code, match.index!)

        // 跳过字符串/注释/正则中的匹配
        if (isInNonCode(code, match.index!)) continue

        issues.push({
          rule: this.rule,
          severity: 'high',
          category: 'security',
          file: filePath,
          line,
          message,
          snippet: match[0].trim(),
          suggestion: '使用参数数组形式调用，如 execFile("ls", [userInput])',
        })
      }
    }
  }

  /** 检测 eval/exec 使用 */
  private checkEvalUsage(code: string, language: string, filePath: string, issues: Issue[]): void {
    const evalPatterns: { regex: RegExp; message: string }[] = []

    if (language === 'python') {
      evalPatterns.push({ regex: /\beval\s*\(/g, message: '使用 eval()，存在安全风险' })
      evalPatterns.push({ regex: /\bexec\s*\(/g, message: '使用 exec()，存在安全风险' })
    } else {
      evalPatterns.push({ regex: /\beval\s*\(/g, message: '使用 eval()，存在安全风险' })
      evalPatterns.push({ regex: /new\s+Function\s*\(/g, message: '使用 new Function()，存在安全风险' })
    }

    // eval/exec 是否危险取决于传入内容是否受控。许多合法场景会使用
    // （如沙箱、模板编译、JSON 解析的替代），误报成本高，故降级为 MEDIUM。
    for (const { regex, message } of evalPatterns) {
      let match
      while ((match = regex.exec(code)) !== null) {
        const line = getLineNumber(code, match.index!)

        // 跳过字符串/注释/正则中的匹配
        if (isInNonCode(code, match.index)) continue

        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'security',
          file: filePath,
          line,
          message,
          snippet: match[0].trim(),
          suggestion: '确认 eval/exec 的输入来源可信，否则替换为更安全的方案',
        })
      }
    }
  }

  /** 检测不安全的 HTTP URL */
  private checkInsecureHTTP(code: string, language: string, filePath: string, issues: Issue[]): void {
    const httpRegex = /['"`](http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^\s'"`]+)['"`]/g
    let match

    while ((match = httpRegex.exec(code)) !== null) {
      const url = match[1]
      // 跳过模板URL（含变量插值的URL，如 http://{host}:{port}）
      if (/\{[^}]+\}/.test(url)) continue
      // 跳过 XML/SVG 命名空间（http://www.w3.org/2000/svg 等）
      if (/^http:\/\/(www\.)?w3\.org\/\d{4}\//.test(url)) continue
      if (/^http:\/\/(www\.)?w3\.org\/(XML|TR|ns)\//.test(url)) continue

      const line = getLineNumber(code, match.index!)
      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'security',
        file: filePath,
        line,
        message: `使用不安全的 HTTP URL: "${match[1].substring(0, 50)}"`,
        snippet: match[0].trim(),
        suggestion: '生产环境应使用 HTTPS，如 https://api.example.com',
      })
    }
  }

  private isPlaceholder(value: string): boolean {
    const placeholders = ['xxx', 'your_', 'replace_', 'insert_', 'change_', 'placeholder', 'example', 'test', 'dummy', 'sample', 'TODO', 'sk-xxx', 'sk-your', 'xxx-', '-xxx']
    const lower = value.toLowerCase()
    return placeholders.some(p => lower.includes(p.toLowerCase()))
  }

  /** 判断 innerHTML 赋值是否包含外部输入特征 */
  private isExternalInputInnerHTML(code: string, matchIndex: number): boolean {
    const lineStart = code.lastIndexOf('\n', matchIndex) + 1
    const lineEnd = code.indexOf('\n', matchIndex)
    const fullLine = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd)
    // 检查赋值右侧是否包含外部输入来源
    const rightSide = fullLine.substring(fullLine.indexOf('=') + 1)
    const externalInputPatterns = [
      /\breq(?:uest)?\./,          // req.body, req.query, request.params
      /\bparams\b/,                // URL 参数
      /\bquery\b/,                 // 查询字符串
      /\.value\b/,                 // 表单输入值
      /\.innerHTML\b/,             // 来自其他 innerHTML
      /\blocalStorage\b/,          // 本地存储
      /\bsessionStorage\b/,        // 会话存储
      /\bdocument\.cookie/,        // Cookie
      /\bwindow\.location/,        // URL
      /\buserInput\b/i,            // 显式命名的用户输入
    ]
    return externalInputPatterns.some(p => p.test(rightSide))
  }

  private checkAISpecificSecurity(code: string, language: string, filePath: string, issues: Issue[]): void {
    // 1. eval/exec 处理不受信输入（AI 常用 eval 做"动态处理"）
    const evalDangerPatterns: { regex: RegExp; message: string }[] = []
    if (language === 'python') {
      evalDangerPatterns.push(
        { regex: /\beval\s*\(\s*(?:input|user|request|data|response|content|payload)/gi, message: 'eval() 处理不受信输入：可能导致代码注入' },
        { regex: /\bexec\s*\(\s*(?:input|user|request|data|response|content|payload)/gi, message: 'exec() 处理不受信输入：可能导致代码注入' },
      )
    } else {
      evalDangerPatterns.push(
        { regex: /\beval\s*\(\s*(?:document|window|location|input|user|params|query|body|req)/gi, message: 'eval() 处理不受信输入：可能导致代码注入' },
        { regex: /new\s+Function\s*\(\s*(?:document|window|location|input|user|params|query|body|req)/gi, message: 'new Function() 处理不受信输入：可能导致代码注入' },
      )
    }

    for (const { regex, message } of evalDangerPatterns) {
      let match
      while ((match = regex.exec(code)) !== null) {
        const line = getLineNumber(code, match.index!)
        if (isInNonCode(code, match.index)) continue

        // 去重：checkEvalUsage 已对同一位置报过 eval，升级为 critical
        const existingIdx = issues.findIndex(
          i => i.line === line && i.rule === this.rule && /eval|exec|Function/i.test(i.message)
        )
        if (existingIdx >= 0) {
          issues[existingIdx].severity = 'critical'
          issues[existingIdx].message = message
          issues[existingIdx].suggestion = '使用安全的替代方案：JSON.parse() 解析数据，或使用沙箱环境执行'
          continue
        }

        issues.push({
          rule: this.rule,
          severity: 'critical',
          category: 'security',
          file: filePath,
          line,
          message,
          snippet: match[0].trim(),
          suggestion: '使用安全的替代方案：JSON.parse() 解析数据，或使用沙箱环境执行',
        })
      }
    }

    // 2. .env 配置文件中的真实密钥（AI 常在 .env 中填入示例连接串）
    if (/\.env(?!\.example|\.sample|\.template)/.test(filePath)) {
      const envSecretPatterns = [
        { regex: /^(?:DATABASE_URL|DB_URI|MONGODB_URI|REDIS_URL|AMQP_URL)\s*=\s*['"]?(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s'"]+['"]?/gm, name: '数据库连接串' },
        { regex: /^(?:AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID)\s*=\s*['"]?[A-Za-z0-9/+=]{20,}['"]?/gm, name: 'AWS 密钥' },
      ]
      for (const { regex, name } of envSecretPatterns) {
        let match
        while ((match = regex.exec(code)) !== null) {
          if (this.isPlaceholder(match[0])) continue
          const line = getLineNumber(code, match.index!)
          issues.push({
            rule: this.rule,
            severity: 'high',
            category: 'security',
            file: filePath,
            line,
            message: `${name} 不应提交到版本控制`,
            snippet: match[0].split('=')[0] + '=***',
            suggestion: '将真实密钥移到 .env.example 之外，使用 .gitignore 排除 .env 文件',
          })
        }
      }
    }

    // 3. 不安全的反序列化（AI 常生成 pickle.loads/YAML.load 处理不受信数据）
    if (language === 'python') {
      const deserialPatterns = [
        { regex: /pickle\.loads?\s*\(\s*(?:request|input|user|data|response|content|payload|file)/gi, message: 'pickle.loads 处理不受信输入：可能导致远程代码执行' },
        { regex: /yaml\.load\s*\(\s*(?!.*Loader\s*=)/gi, message: 'yaml.load 不指定 Loader 不安全' },
      ]
      for (const { regex, message } of deserialPatterns) {
        let match
        while ((match = regex.exec(code)) !== null) {
          if (isInNonCode(code, match.index)) continue
          const line = getLineNumber(code, match.index!)
          issues.push({
            rule: this.rule,
            severity: 'critical',
            category: 'security',
            file: filePath,
            line,
            message,
            snippet: match[0].trim(),
            suggestion: message.includes('pickle')
              ? '使用 json.loads() 替代 pickle，或确保输入来源可信'
              : '使用 yaml.load(data, Loader=yaml.SafeLoader)',
          })
        }
      }
    }
  }

  /** 检查是否为枚举/常量标识符（key 与 value 本质相同，如 RESET_PASSWORD: 'reset_password'） */
  private isEnumIdentifier(fullMatch: string, value: string): boolean {
    // 从完整匹配中提取 key：取 [:=] 之前的单词部分
    const keyMatch = fullMatch.match(/^(\w+)\s*[:=]/)
    if (!keyMatch) return false

    const normalize = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, '')
    const normalizedKey = normalize(keyMatch[1])
    const normalizedValue = normalize(value)

    return normalizedKey === normalizedValue
  }

}
