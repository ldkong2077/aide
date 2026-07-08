/**
 * AIDE - 资源泄漏检测器
 * 检测文件/连接/流未正确关闭的情况
 */

import { stripComments, stripStrings } from '../core/type-inferencer.js'
import { getLineNumber, escapeRegex } from '../core/utils.js'
import { isTestFile } from '../types/index.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'

export class ResourceLeakDetector implements Detector {
  rule = 'resource-leak'
  category = 'ai-code' as const
  description = '检测未正确关闭的资源（文件/连接/流）'
  severity = 'medium' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath } = ctx
    const issues: Issue[] = []

    // 跳过测试文件
    if (isTestFile(filePath)) return issues

    switch (language) {
      case 'python':
        this.checkPythonResourceLeaks(source, filePath, issues)
        break
      case 'typescript':
      case 'javascript':
        this.checkJSResourceLeaks(source, filePath, issues)
        break
      case 'java':
        this.checkJavaResourceLeaks(source, filePath, issues)
        break
      case 'go':
        this.checkGoResourceLeaks(source, filePath, issues)
        break
      case 'rust':
        this.checkRustResourceLeaks(source, filePath, issues)
        break
      case 'php':
        this.checkPHPResourceLeaks(source, filePath, issues)
        break
      case 'ruby':
        this.checkRubyResourceLeaks(source, filePath, issues)
        break
    }

    return issues
  }

  /** Python 资源泄漏检测 */
  private checkPythonResourceLeaks(code: string, filePath: string, issues: Issue[]): void {
    const lines = code.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // 检测 open() 未使用 with 语句
      const openMatch = /^\s*(\w+)\s*=\s*open\s*\(/.exec(lines[i])
      if (openMatch) {
        const varName = openMatch[1]
        // 检查是否在 with 块内（上一行或同行有 with）
        const prevLines = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
        if (!/with\s+open\s*\(/.test(prevLines) && !/with\s+.*\s+as\s+/.test(prevLines)) {
          // 检查是否有 close() 调用
          const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'python')
          const hasClose = this.hasMethodCall(varName, ['close'], remainingCode)

          if (!hasClose && !this.isResourceTransferred(varName, remainingCode) && !this.isResourceIndirectlyClosed(varName, remainingCode)) {
            issues.push({
              rule: this.rule,
              severity: 'medium',
              category: 'ai-code',
              file: filePath,
              line: i + 1,
              message: `文件可能未正确关闭: open() 未使用 with 语句且未调用 close()`,
              snippet: line,
              suggestion: '使用 with open(...) as f: 确保文件自动关闭',
            })
          }
        }
      }

      // 检测数据库连接未关闭
      const dbConnPatterns = [
        /(\w+)\s*=\s*(?:sqlite3|psycopg2|pymysql|mysql)\.connect\s*\(/,
        /(\w+)\s*=\s*(?:redis|mongoclient)\.(?:Redis|MongoClient)\s*\(/,
      ]
      for (const pattern of dbConnPatterns) {
        const match = pattern.exec(lines[i])
        if (match) {
          const varName = match[1]
          const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'python')
          const hasClose = this.hasMethodCall(varName, ['close', 'end'], remainingCode)

          if (!hasClose && !this.isResourceTransferred(varName, remainingCode) && !this.isResourceIndirectlyClosed(varName, remainingCode)) {
            issues.push({
              rule: this.rule,
              severity: 'medium',
              category: 'ai-code',
              file: filePath,
              line: i + 1,
              message: `数据库连接可能未关闭: ${varName}`,
              snippet: line,
              suggestion: '使用 with 语句或在 finally 块中调用 close()',
            })
          }
        }
      }
    }
  }

  /** JS/TS 资源泄漏检测 */
  private checkJSResourceLeaks(code: string, filePath: string, issues: Issue[]): void {
    const lines = code.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // 检测 fs.open / fs.createReadStream 未关闭
      const streamPatterns = [
        { regex: /(?:const|let|var)\s+(\w+)\s*=\s*fs\.createReadStream\s*\(/, type: 'ReadStream' },
        { regex: /(?:const|let|var)\s+(\w+)\s*=\s*fs\.createWriteStream\s*\(/, type: 'WriteStream' },
        { regex: /(?:const|let|var)\s+(\w+)\s*=\s*fs\.open\s*\(/, type: 'FileHandle' },
        { regex: /(?:const|let|var)\s+(\w+)\s*=\s*net\.createConnection\s*\(/, type: 'Socket' },
        { regex: /(?:const|let|var)\s+(\w+)\s*=\s*http\.request\s*\(/, type: 'ClientRequest' },
      ]

      for (const { regex, type } of streamPatterns) {
        const match = regex.exec(lines[i])
        if (match) {
          const varName = match[1]
          const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'typescript')
          const hasClose = this.hasMethodCall(varName, ['close', 'destroy', 'end'], remainingCode)
          const hasOnEnd = new RegExp(`${this.varRefPattern(varName)}\\s*\\.\\s*on\\s*\\(\\s*['"]end['"]`).test(remainingCode)
          const hasPipe = this.hasMethodCall(varName, ['pipe'], remainingCode)

          if (!hasClose && !hasOnEnd && !hasPipe && !this.isResourceTransferred(varName, remainingCode)) {
            issues.push({
              rule: this.rule,
              severity: 'medium',
              category: 'ai-code',
              file: filePath,
              line: i + 1,
              message: `${type} 可能未正确关闭: ${varName}`,
              snippet: line,
              suggestion: `使用 ${varName}.destroy() 或 ${varName}.close() 关闭资源，或使用流式管道 pipe()`,
            })
          }
        }
      }

      // 检测数据库连接未关闭
      const dbPatterns = [
        { regex: /(?:const|let|var)\s+(\w+)\s*=\s*(?:new\s+)?(?:mysql|pg|mongodb|redis|mongoose)\.(?:createConnection|createPool|connect|MongoClient)\s*\(/, type: '数据库连接' },
      ]

      for (const { regex, type } of dbPatterns) {
        const match = regex.exec(lines[i])
        if (match) {
          const varName = match[1]
          const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'typescript')
          const hasClose = this.hasMethodCall(varName, ['close', 'end', 'disconnect'], remainingCode)

          if (!hasClose && !this.isResourceTransferred(varName, remainingCode)) {
            issues.push({
              rule: this.rule,
              severity: 'medium',
              category: 'ai-code',
              file: filePath,
              line: i + 1,
              message: `${type}可能未关闭: ${varName}`,
              snippet: line,
              suggestion: '在 finally 块中调用 close() 或使用连接池自动管理',
            })
          }
        }
      }
    }
  }

  /** Java 资源泄漏检测 */
  private checkJavaResourceLeaks(code: string, filePath: string, issues: Issue[]): void {
    const lines = code.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // 跳过 try-with-resources
      if (/try\s*\(/.test(lines[i])) continue

      // 检测资源创建未关闭
      const resourcePatterns = [
        { regex: /(?:new\s+)?(FileInputStream|FileOutputStream|BufferedReader|BufferedWriter|FileReader|FileWriter|InputStream|OutputStream)\s*\(/, type: '文件流' },
        { regex: /(?:new\s+)?(Connection|Statement|PreparedStatement|ResultSet)\s*\(/, type: '数据库资源' },
        { regex: /(?:new\s+)?(Socket|ServerSocket|HttpURLConnection)\s*\(/, type: '网络连接' },
      ]

      for (const { regex, type } of resourcePatterns) {
        const match = regex.exec(lines[i])
        if (match) {
          // 检查是否在 try-with-resources 内
          const prevLines = lines.slice(Math.max(0, i - 5), i + 1).join('\n')
          if (/try\s*\(/.test(prevLines)) continue

          // 检查是否有 close() 调用
          const varMatch = /(\w+)\s*=\s*(?:new\s+)?/.exec(lines[i])
          if (varMatch) {
            const varName = varMatch[1]
            const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'java')
            const hasClose = this.hasMethodCall(varName, ['close'], remainingCode)

            if (!hasClose && !this.isResourceTransferred(varName, remainingCode)) {
              issues.push({
                rule: this.rule,
                severity: 'medium',
                category: 'ai-code',
                file: filePath,
                line: i + 1,
                message: `Java ${type}可能未关闭: ${varName}`,
                snippet: line,
                suggestion: '使用 try-with-resources 语句确保资源自动关闭',
              })
            }
          }
        }
      }
    }
  }

  /** Go 资源泄漏检测 */
  private checkGoResourceLeaks(code: string, filePath: string, issues: Issue[]): void {
    const lines = code.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // 检测 os.Open / os.Create / os.OpenFile
      const filePatterns = [
        { regex: /(\w+)\s*,\s*err\s*:=\s*os\.(Open|Create|OpenFile)\s*\(/, type: '文件' },
        { regex: /(\w+)\s*,\s*err\s*:=\s*net\.(Dial|Listen)\s*\(/, type: '网络连接' },
        { regex: /(\w+)\s*:=\s*sql\.(Open|OpenDB)\s*\(/, type: '数据库连接' },
      ]

      for (const { regex, type } of filePatterns) {
        const match = regex.exec(lines[i])
        if (match) {
          const varName = match[1]
          // 检查是否有 defer xxx.Close()
          const remainingCode = this.cleanCode(lines.slice(i + 1, Math.min(i + 20, lines.length)).join('\n'), 'go')
          const fullRemainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'go')
          const hasDeferClose = new RegExp(`\bdefer\s+${this.varRefPattern(varName)}\s*\.\s*Close\s*\(\)`).test(remainingCode)
          const hasClose = this.hasMethodCall(varName, ['Close'], fullRemainingCode)

          if (!hasDeferClose && !hasClose && !this.isResourceTransferred(varName, fullRemainingCode)) {
            issues.push({
              rule: this.rule,
              severity: 'medium',
              category: 'ai-code',
              file: filePath,
              line: i + 1,
              message: `Go ${type}可能未关闭: ${varName}`,
              snippet: line,
              suggestion: `在打开资源后立即添加 defer ${varName}.Close() 确保资源关闭`,
            })
          }
        }
      }
    }
  }

  /** Rust 资源泄漏检测 */
  private checkRustResourceLeaks(code: string, filePath: string, issues: Issue[]): void {
    const lines = code.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Rust 的 RAII 机制通常会自动关闭资源
      // 但 BufWriter 需要显式 flush
      const bufWriterMatch = /(?:let\s+)?(?:mut\s+)?(\w+)\s*(?::\s*BufWriter<.*?>)?\s*=\s*BufWriter::new\s*\(/.exec(lines[i])
      if (bufWriterMatch) {
        const varName = bufWriterMatch[1]
        const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'rust')
        const hasFlush = this.hasMethodCall(varName, ['flush'], remainingCode)
        const hasDrop = new RegExp(`\\bdrop\\s*\\(\\s*${this.varRefPattern(varName)}\\s*\\)`).test(remainingCode)

        if (!hasFlush && !hasDrop && !this.isResourceTransferred(varName, remainingCode)) {
          issues.push({
            rule: this.rule,
            severity: 'low',
            category: 'ai-code',
            file: filePath,
            line: i + 1,
            message: `Rust BufWriter 可能未 flush: ${varName}`,
            snippet: line,
            suggestion: '在程序结束前调用 .flush() 或使用 drop() 确保 BufWriter 数据写入磁盘',
          })
        }
      }
    }
  }

  /** PHP 资源泄漏检测 */
  private checkPHPResourceLeaks(code: string, filePath: string, issues: Issue[]): void {
    const lines = code.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // 检测 fopen() 未关闭
      const fopenMatch = /(\$\w+)\s*=\s*fopen\s*\(/.exec(lines[i])
      if (fopenMatch) {
        const varName = fopenMatch[1]
        const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'php')
        const hasClose = new RegExp(`${this.varRefPattern(varName)}\\s*=\\s*null|\\bfclose\\s*\\(\\s*${this.varRefPattern(varName)}\\s*\\)`).test(remainingCode)

        if (!hasClose && !this.isResourceTransferred(varName, remainingCode)) {
          issues.push({
            rule: this.rule,
            severity: 'medium',
            category: 'ai-code',
            file: filePath,
            line: i + 1,
            message: `PHP 文件句柄可能未关闭: ${varName}`,
            snippet: line,
            suggestion: '使用 fclose() 关闭文件句柄，或将文件操作放在 try/finally 块中',
          })
        }
      }

      // 检测 curl_init() 未关闭
      const curlMatch = /(\$\w+)\s*=\s*curl_init\s*\(/.exec(lines[i])
      if (curlMatch) {
        const varName = curlMatch[1]
        const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'php')
        const hasClose = new RegExp(`\\bcurl_close\\s*\\(\\s*${this.varRefPattern(varName)}\\s*\\)`).test(remainingCode)

        if (!hasClose && !this.isResourceTransferred(varName, remainingCode)) {
          issues.push({
            rule: this.rule,
            severity: 'medium',
            category: 'ai-code',
            file: filePath,
            line: i + 1,
            message: `PHP cURL 句柄可能未关闭: ${varName}`,
            snippet: line,
            suggestion: '使用 curl_close() 关闭 cURL 句柄',
          })
        }
      }
    }
  }

  /** Ruby 资源泄漏检测 */
  private checkRubyResourceLeaks(code: string, filePath: string, issues: Issue[]): void {
    const lines = code.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // 检测 File.open 未使用块形式
      const fileMatch = /(\w+)\s*=\s*File\.open\s*\(/.exec(lines[i])
      if (fileMatch) {
        const varName = fileMatch[1]
        const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'ruby')
        const hasClose = this.hasMethodCall(varName, ['close'], remainingCode)

        if (!hasClose && !this.isResourceTransferred(varName, remainingCode)) {
          issues.push({
            rule: this.rule,
            severity: 'medium',
            category: 'ai-code',
            file: filePath,
            line: i + 1,
            message: `Ruby 文件可能未关闭: ${varName}`,
            snippet: line,
            suggestion: '使用 File.open(path) { |f| ... } 块形式确保文件自动关闭',
          })
        }
      }

      // 检测数据库连接未关闭
      const dbMatch = /(\w+)\s*=\s*(?:Mysql2::Client|PG::Connection|Mongo::Client|Redis::new)\.(?:new|connect)\s*\(/.exec(lines[i])
      if (dbMatch) {
        const varName = dbMatch[1]
        const remainingCode = this.cleanCode(lines.slice(i + 1).join('\n'), 'ruby')
        const hasClose = this.hasMethodCall(varName, ['close'], remainingCode)

        if (!hasClose && !this.isResourceTransferred(varName, remainingCode)) {
          issues.push({
            rule: this.rule,
            severity: 'medium',
            category: 'ai-code',
            file: filePath,
            line: i + 1,
            message: `Ruby 数据库连接可能未关闭: ${varName}`,
            snippet: line,
            suggestion: '在确保操作完成后调用 .close 关闭连接',
          })
        }
      }
    }
  }

  private cleanCode(code: string, language: string): string {
    return code.split('\n').map(line => stripStrings(stripComments(line, language), language)).join('\n')
  }

  private hasMethodCall(varName: string, methodNames: string[], code: string): boolean {
    const methods = methodNames.map(m => escapeRegex(m)).join('|')
    return new RegExp(`${this.varRefPattern(varName)}\\s*\\.\\s*(?:${methods})\\s*\\(`).test(code)
  }

  private isResourceTransferred(varName: string, remainingCode: string): boolean {
    const varRef = this.varRefPattern(varName)
    return new RegExp(`\\breturn\\s+${varRef}\\s*(?:[;\\n]|$)`).test(remainingCode)
      || new RegExp(`\\byield\\s+${varRef}\\s*(?:[;\\n]|$)`).test(remainingCode)
      || new RegExp(`\\b\\w+\\.\\w+\\s*=\\s*${varRef}`).test(remainingCode)
      || new RegExp(`\\b(?:pipeline|send|respond|upload|consume|handle|registerCleanup)\\s*\\([^)]*${varRef}[^)]*\\)`).test(remainingCode)
  }

  private varRefPattern(varName: string): string {
    const escaped = escapeRegex(varName)
    if (varName.startsWith('$')) return `(?:^|[^\\w$])${escaped}(?!\\w)`
    return `\\b${escaped}\\b`
  }

  /** Check if the resource is closed indirectly (via owner object's close() or in finally block) */
  private isResourceIndirectlyClosed(varName: string, remainingCode: string): boolean {
    // Check if var is an attribute (e.g., self._conn, store._conn)
    const attrMatch = /^(\w+)\.\w+$/.exec(varName)
    if (attrMatch) {
      const owner = attrMatch[1]
      // Check if owner has a close() method
      if (new RegExp(`\\b${escapeRegex(owner)}\\.close\\(\\)`).test(remainingCode)) {
        return true
      }
    }
    // Check if closed in finally block
    const finallyMatch = /finally\s*:/.exec(remainingCode)
    if (finallyMatch) {
      const afterFinally = remainingCode.substring(finallyMatch.index)
      // Look for .close() within the finally block (next few lines)
      const finallyLines = afterFinally.split('\n').slice(0, 5).join('\n')
      if (/\.close\s*\(\)/.test(finallyLines)) {
        return true
      }
    }
    return false
  }

  }
