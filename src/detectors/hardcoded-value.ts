/**
 * AIDE - 硬编码值检测器
 * 检测代码中硬编码的 URL、端口、路径、IP 地址等
 */

import { isTestFile } from '../types/index.js'
import { getLineNumber, isInNonCode } from '../core/utils.js'
import type { Detector, DetectorContext, Issue, Confidence } from '../types/index.js'

export class HardcodedValueDetector implements Detector {
  rule = 'hardcoded-value'
  category = 'quality' as const
  description = '检测硬编码的 URL、端口、路径、IP 地址'
  severity = 'medium' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath } = ctx
    const issues: Issue[] = []

    // 排除测试文件
    if (isTestFile(filePath)) return issues

    // 新增：跳过配置文件和安全规则文件——其中的硬编码值是有意的
    // 注意：不用 \b 做左边界，因为 _presets 等下划线连接的文件名中 \b 不匹配
    if (/(?:^|[\\/_])(?:presets?|configs?|constants?|settings?|ssrf|blocklist|block_list|blacklist|black_list|whitelist|white_list)\b/i.test(filePath)) {
      return issues
    }

    this.checkHardcodedURLs(source, language, filePath, issues)
    this.checkHardcodedIPs(source, filePath, issues)
    this.checkHardcodedPorts(source, language, filePath, issues)
    this.checkHardcodedPaths(source, language, filePath, issues)

    return issues
  }

  /** 检测硬编码 URL */
  private checkHardcodedURLs(code: string, language: string, filePath: string, issues: Issue[]): void {
    // 匹配字符串中的 URL（排除注释和已知公共 URL）
    const urlRegex = /['"`](https?:\/\/(?!example\.com|localhost|127\.0\.0\.1|0\.0\.0\.0|docs\.\w+\.(com|io|org)|www\.w3\.org|schema\.org)[^\s'"`]+)['"`]/g
    let match

    while ((match = urlRegex.exec(code)) !== null) {
      const url = match[1]
      const line = getLineNumber(code, match.index!)

      // 跳过模板URL（含变量插值的URL，如 https://{host}:{port}）
      if (/\{[^}]+\}/.test(url)) continue

      // 跳过常见公共 URL
      if (this.isPublicURL(url)) continue

      // 跳过 XML/SVG 命名空间 URL（如 http://www.w3.org/2000/svg, http://www.w3.org/1999/xhtml）
      if (/^https?:\/\/(www\.)?w3\.org\/\d{4}\//.test(url)) continue
      // 跳过 XML Schema 命名空间
      if (/^https?:\/\/(www\.)?w3\.org\/(XML|TR|ns)\//.test(url)) continue

      // 跳过注释/字符串/正则中的 URL
      if (isInNonCode(code, match.index!)) continue

      // 跳过 GitHub/GitLab 相关 URL（常见于 README、配置）
      if (/github\.com|gitlab\.com|bitbucket\.org|raw\.githubusercontent\.com/.test(url)) continue

      // 跳过文档/规范相关 URL
      if (/developer\.mozilla\.org|docs\.python\.org|go\.dev|doc\.rust-lang\.org|kotlinlang\.org/.test(url)) continue

      // 跳过 CDN/公共资源 URL
      if (/cdn\.|unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com/.test(url)) continue

      // 跳过配置文件中的 URL（config/settings/presets 目录）
      if (/(?:^|[\\/_])(?:config|settings?|presets?|constants?)\.(?:js|ts|json|yaml|yml|toml)$/i.test(filePath)) {
        continue
      }

      // 跳过 placeholder 属性中的 URL（HTML/JSX 输入提示文本，非实际使用的 URL）
      const lineStart = code.lastIndexOf('\n', match.index) + 1
      const lineEnd = code.indexOf('\n', match.index)
      const fullLine = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd)
      const beforeUrl = fullLine.slice(0, match.index - lineStart)
      if (/placeholder\s*=\s*["']?$/.test(beforeUrl.trimEnd()) ||
          /placeholder\s*=\s*\{\s*["']?$/.test(beforeUrl.trimEnd())) {
        continue
      }

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'quality',
        file: filePath,
        line,
        message: `硬编码的 URL: "${url}"`,
        snippet: match[0].trim(),
        suggestion: '使用环境变量或配置文件存储 URL，如 process.env.API_URL',
        confidence: 'medium' as Confidence,
      })
    }
  }

  /** 检测硬编码 IP 地址 */
  private checkHardcodedIPs(code: string, filePath: string, issues: Issue[]): void {
    const ipRegex = /['"`](\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})['"`]/g
    let match

    while ((match = ipRegex.exec(code)) !== null) {
      const ip = match[1]
      const line = getLineNumber(code, match.index!)

      // 跳过 localhost 和常见开发 IP
      if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '255.255.255.255') continue
      // 跳过 169.254.x.x（云元数据链路本地地址，安全规则常见）
      if (ip.startsWith('169.254.')) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'quality',
        file: filePath,
        line,
        message: `硬编码的 IP 地址: "${ip}"`,
        snippet: match[0].trim(),
        suggestion: '使用环境变量或配置文件存储 IP 地址',
        confidence: 'medium' as Confidence,
      })
    }
  }

  /** 检测硬编码端口 */
  private checkHardcodedPorts(code: string, language: string, filePath: string, issues: Issue[]): void {
    // 常见数据库/服务端口
    const sensitivePorts: Record<string, string> = {
      '3306': 'MySQL',
      '5432': 'PostgreSQL',
      '27017': 'MongoDB',
      '6379': 'Redis',
      '9200': 'Elasticsearch',
      '1433': 'SQL Server',
      '1521': 'Oracle',
      '5672': 'RabbitMQ',
      '9092': 'Kafka',
    }

    // 匹配连接字符串中的端口
    const portPatterns = [
      /localhost:(\d{4,5})/g,
      /127\.0\.0\.1:(\d{4,5})/g,
      /0\.0\.0\.0:(\d{4,5})/g,
    ]

    for (const regex of portPatterns) {
      let match
      while ((match = regex.exec(code)) !== null) {
        const port = match[1]
        const line = getLineNumber(code, match.index!)

        // 跳过 process.env || 默认值 模式（环境变量的 fallback 不是硬编码）
        const lineStart = code.lastIndexOf('\n', match.index) + 1
        const lineEnd = code.indexOf('\n', match.index)
        const fullLine = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd)
        if (/\bprocess\.env\b/.test(fullLine) && /\|\|/.test(fullLine.slice(0, match.index - lineStart))) continue

        if (sensitivePorts[port]) {
          issues.push({
            rule: this.rule,
            severity: 'medium',
            category: 'quality',
            file: filePath,
            line,
            message: `硬编码的${sensitivePorts[port]}端口: ${match[0]}`,
            snippet: match[0].trim(),
            suggestion: `使用环境变量存储${sensitivePorts[port]}端口，如 process.env.DB_PORT`,
            confidence: 'medium' as Confidence,
          })
        }
      }
    }
  }

  /** 检测硬编码文件路径 */
  private checkHardcodedPaths(code: string, language: string, filePath: string, issues: Issue[]): void {
    const pathPatterns: RegExp[] = []

    if (language === 'python') {
      pathPatterns.push(/['"`](\/(?:usr|var|etc|opt|home)\/[^\s'"`]+)['"`]/g)
      pathPatterns.push(/['"`](C:\\(?:Users|Program Files|Windows)[^\s'"`]*?)['"`]/gi)
    } else {
      pathPatterns.push(/['"`](\/(?:usr|var|etc|opt|home)\/[^\s'"`]+)['"`]/g)
      pathPatterns.push(/['"`](C:\\(?:Users|Program Files|Windows)[^\s'"`]*?)['"`]/gi)
    }

    for (const regex of pathPatterns) {
      let match
      while ((match = regex.exec(code)) !== null) {
        const path = match[1]
        const line = getLineNumber(code, match.index!)

        issues.push({
          rule: this.rule,
          severity: 'low',
          category: 'quality',
          file: filePath,
          line,
          message: `硬编码的文件路径: "${path}"`,
          snippet: match[0].trim(),
          suggestion: '使用环境变量或 path.join() 构建文件路径',
          confidence: 'low' as Confidence,
        })
      }
    }
  }

  private isPublicURL(url: string): boolean {
    const publicDomains = [
      'github.com', 'npmjs.com', 'pypi.org', 'crates.io',
      'developer.mozilla.org', 'react.dev', 'vuejs.org', 'angular.io',
      'nodejs.org', 'python.org', 'golang.org', 'rust-lang.org',
      'typescriptlang.org', 'webpack.js.org', 'vitejs.dev',
      // 新增：已知第三方 API 域名
      'weixin.qq.com', 'bigmodel.cn', 'siliconflow.cn', 'stepfun.com',
      'dashscope.aliyuncs.com', 'api.lingyiwanwu.com',
      // 新增：常见 AI API 域名
      'api.openai.com', 'api.anthropic.com', 'api.minimax.chat',
      'api.cohere.ai', 'api.ai21.com', 'api.inference.ai',
      'api.groq.com', 'api.deepseek.com', 'api.mistral.ai',
      'api.x.ai', 'api.fireworks.ai', 'api.together.xyz',
      // 新增：常见云服务 API 域名
      'api.aws.amazon.com', 'api.azure.com', 'api.cloud.google.com',
      'api.vercel.app', 'api.netlify.app', 'api.heroku.com',
      // 新增：文档/规范类
      'httpbin.org', 'jsonplaceholder.typicode.com',
      'reqres.in', 'mockapi.io', 'fakestoreapi.com',
      // 新增：CDN/公共资源
      'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
      'fonts.googleapis.com', 'fonts.gstatic.com',
      // 新增：GitHub 相关
      'raw.githubusercontent.com', 'gist.github.com',
      'api.github.com', 'github.io',
    ]
    return publicDomains.some(d => url.includes(d))
  }
}
