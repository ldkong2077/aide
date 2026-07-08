/**
 * AIDE - 伪造 API URL 检测器
 * 检测代码中可能伪造的 API URL
 *
 * 匹配 http(s)://api.{domain}.{tld}/{path} 格式
 * 对比已知真实 API 域名白名单，不在白名单中的标记为可能伪造
 */

import { isTestFile } from '../types/index.js'
import { getLineNumber } from '../core/utils.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'

/** 已知真实 API 域名白名单 */
  const KNOWN_API_DOMAINS = new Set([
  'github',
  'openai',
  'anthropic',
  'google',
  'stripe',
  'cloudflare',
  'aws',
  'azure',
  'firebase',
  'vercel',
  'deepseek',
  'zhipu',
  'baidu',
  'aliyun',
  'tencent',
  'moonshot',
  'minimax',
  'baichuan',
  'baichuan-ai',      // 百川 api.baichuan-ai.com
  'spark',
  'doubao',
  'qwen',
  'cohere',
  'mistral',
  'huggingface',
  'replicate',
  'stability',
  'perplexity',
  'groq',
  'together',
  'ollama',
  // 新增：国内 LLM 厂商真实域名
  'siliconflow',       // 硅基流动 api.siliconflow.cn
  'stepfun',           // 阶跃星辰 api.stepfun.com
  'lingyiwanwu',       // 零一万物 api.lingyiwanwu.com
  'bigmodel',          // 智谱 open.bigmodel.cn
  'baidubce',          // 百度千帆 qianfan.baidubce.com
  'dashscope',         // 通义千问 dashscope.aliyuncs.com
  'aliyuncs',          // 阿里云 dashscope.aliyuncs.com
  'weixin',            // 微信 api.weixin.qq.com
  'ilinkai',           // 微信 iLink ilinkai.weixin.qq.com
  'example',           // 示例/占位URL（RFC 2606保留域名）
])

export class FakeUrlDetector implements Detector {
  rule = 'fake-url'
  category = 'hallucination' as const
  description = '检测伪造的 API URL'
  severity = 'medium' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, filePath } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    const issues: Issue[] = []

    // 匹配 http(s)://api.{domain}.{tld}/{path}
    const urlRegex = /https?:\/\/api\.([a-z0-9-]+)\.[a-z]{2,}(?:\.[a-z]{2,})?\/\S*/gi
    let match: RegExpExecArray | null

    while ((match = urlRegex.exec(source)) !== null) {
      const fullUrl = match[0]
      const domain = match[1]!.toLowerCase()

      if (KNOWN_API_DOMAINS.has(domain)) continue

      const line = getLineNumber(source, match.index!)

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath,
        line,
        message: `可能伪造的 API URL: "${fullUrl}" (域名 "${domain}" 不在已知白名单中)`,
        snippet: fullUrl,
        suggestion: `请确认此 API URL 是否真实存在。AI 生成的代码可能包含不存在的 API 端点`,
      })
    }

    return issues
  }
}
