/**
 * AIDE - 通用 LLM HTTP 客户端
 * 支持三种 API 格式：Chat Completions / Anthropic Messages / Responses
 * 用户自由配置 Base URL + API Key + 模型名，对接任何兼容服务
 */

import type { LlmApiFormat } from '../types/index.js'
import type { IssueWithContext, LlmResponse, LLMProvider } from './llm-types.js'

const SYSTEM_PROMPT = `你是 AIDE 代码监工。精准判断代码问题是否为真实问题。

## 角色
- 你是监工，不是教练。只判断真假，不教怎么写代码。
- 宁可放过，不误杀。拿不准时判 verified。

## 判断标准
- **false_positive（误报）**：规则触发了，但代码是正确的
- **verified（真实问题）**：确实是问题
- **enhanced（增强）**：是问题，且你能提供更准确的描述

## 输出格式
对每个 issue 输出一行 JSON：
{"verdict": "verified" | "false_positive" | "enhanced", "reason": "一句话原因"}

如果是 enhanced，额外加：
{"enhancedMessage": "改进后的描述", "enhancedSuggestion": "改进后的建议", "enhancedSeverity": "critical" | "high" | "medium" | "low" | "info"}

每条 issue 用 --- Issue #N --- 分隔。不要多余的解释文字。`

/** 按规则动态生成的误报提示（减少 system prompt 体积，按需拼接到 user prompt） */
const RULE_HINTS: Record<string, string[]> = {
  'stub-function': [
    '布尔前缀函数(isX/hasX/canX)返回true/false是合理的守卫模式',
    'Factory Pattern(createXxx/makeXxx)返回默认值是合理的',
    'noop函数是有意设计的空操作',
    '构造函数不是 stub',
  ],
  'empty-impl': [
    'Python dunder 方法(__init__等)简单实现合法',
    '@abstractmethod/@Override/@property 装饰的方法空实现合法',
    'Go init() 由运行时调用',
    'React 空组件(Placeholder)合法',
    'Event Handler 空实现合法',
    '接口 default 方法空实现合法',
  ],
  'unused-declaration': [
    'export 符号是被其他文件使用的',
    'Python UPPER_CASE 常量是模块 API',
    'TYPE_CHECKING 块中的 import 仅用于类型检查',
    'Side-effect import 不引用符号是正常的',
    '__all__ 中声明的符号是公共 API',
  ],
  'api-hallucination': [
    'pandas.DataFrame.merge() 合法（不是 dict.merge 幻觉）',
    'numpy.ndarray.flatten() 合法',
    'TypeScript 5.4+ Array.prototype.last() 合法',
  ],
  'package-hallucination': [
    'Python poetry 项目使用 pyproject.toml 管理依赖',
    'Go init() 函数由运行时自动调用',
  ],
  'swallowed-error': [
    'catch 块含 console.error/log/warn 是有效错误处理',
    'Go 的 _ 忽略错误是惯用写法',
  ],
  'unhandled-promise': [
    'fire-and-forget 模式（日志、监控上报）不需要 await',
  ],
  'weak-validation': [
    'TypeScript 类型注解已提供编译期验证',
    'schema 验证库(zod/pydantic)提供完整验证',
  ],
  'fake-url': [
    '示例/文档 URL (example.com, docs.xxx) 不是虚假 URL',
  ],
}

/** 获取本次批次中涉及的规则的误报提示 */
function getRuleHints(issues: IssueWithContext[]): string {
  const rulesInBatch = new Set(issues.map(i => i.issue.rule))
  const hints: string[] = []
  for (const rule of rulesInBatch) {
    const ruleHints = RULE_HINTS[rule]
    if (ruleHints) {
      hints.push(...ruleHints)
    }
  }
  return hints.length > 0
    ? `\n## 本次涉及的规则常见误报（判 false_positive）\n${hints.map(h => `- ${h}`).join('\n')}\n`
    : ''
}

export class GenericLlmProvider implements LLMProvider {
  readonly name: string
  readonly model: string
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly apiFormat: LlmApiFormat
  private readonly timeout: number

  constructor(config: {
    name: string
    baseUrl: string
    apiKey: string
    model: string
    apiFormat: LlmApiFormat
    timeout?: number
  }) {
    this.name = config.name
    this.model = config.model
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.apiFormat = config.apiFormat
    this.timeout = config.timeout ?? 30000
  }

  async reviewBatch(issues: IssueWithContext[]): Promise<Map<number, LlmResponse>> {
    if (!this.apiKey) {
      throw new Error(`${this.name}: API Key 未配置`)
    }

    const userPrompt = buildUserPrompt(issues)
    const body = buildRequestBody(this.apiFormat, this.model, userPrompt)
    const headers = buildHeaders(this.apiFormat, this.apiKey)

    const res = await fetch(`${this.baseUrl}/${body.endpoint}`, {
      method: 'POST',
      headers,
      body: body.payload,
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${this.name} API 错误 (${res.status}): ${text.slice(0, 500)}`)
    }

    const content = await parseResponseBody(this.apiFormat, res)
    return parseLlmResponse(content, issues)
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.apiKey) return false
      const body = buildRequestBody(this.apiFormat, this.model, 'ping')
      const headers = buildHeaders(this.apiFormat, this.apiKey)
      const res = await fetch(`${this.baseUrl}/${body.endpoint}`, {
        method: 'POST',
        headers,
        body: body.payload,
        signal: AbortSignal.timeout(5000),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

// ==================== 请求构建 ====================

function buildRequestBody(
  apiFormat: LlmApiFormat,
  model: string,
  userPrompt: string,
): { endpoint: string; payload: string } {
  switch (apiFormat) {
    case 'chat-completions': {
      const payload = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      })
      return { endpoint: '/chat/completions', payload }
    }

    case 'anthropic-messages': {
      const payload = JSON.stringify({
        model,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 4096,
        temperature: 0.1,
      })
      return { endpoint: '/v1/messages', payload }
    }

    case 'responses': {
      const payload = JSON.stringify({
        model,
        input: [{ type: 'input_message', role: 'user', content: userPrompt }],
        system: SYSTEM_PROMPT,
        temperature: 0.1,
        max_output_tokens: 4096,
      })
      return { endpoint: '/v1/responses', payload }
    }
  }
}

function buildHeaders(apiFormat: LlmApiFormat, apiKey: string): Record<string, string> {
  switch (apiFormat) {
    case 'chat-completions':
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      }
    case 'anthropic-messages':
      return {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      }
    case 'responses':
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      }
  }
}

// ==================== 响应解析 ====================

async function parseResponseBody(
  apiFormat: LlmApiFormat,
  res: Response,
): Promise<string> {
  switch (apiFormat) {
    case 'chat-completions': {
      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      return json.choices?.[0]?.message?.content ?? ''
    }

    case 'anthropic-messages': {
      const json = await res.json() as { content?: Array<{ text?: string }> }
      return json.content?.[0]?.text ?? ''
    }

    case 'responses': {
      const json = await res.json() as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
      const outputItem = json.output?.[0]
      if (outputItem?.content) {
        const textItem = outputItem.content.find((c) => c.type === 'message')
        return textItem?.text ?? ''
      }
      // 兼容早期 responses API 格式
      const textItem = outputItem?.content?.[0] as { type?: string; text?: string } | undefined
      return textItem?.text ?? ''
    }
  }
}

// ==================== Prompt 构建 ====================

function buildUserPrompt(issues: IssueWithContext[]): string {
  const lines: string[] = []
  lines.push(`请审查以下 ${issues.length} 个检测器报告的代码问题。`)

  // 按需拼接本次批次涉及的规则误报提示
  const ruleHints = getRuleHints(issues)
  if (ruleHints) {
    lines.push(ruleHints)
  }

  lines.push('')

  for (let i = 0; i < issues.length; i++) {
    const item = issues[i]!
    lines.push(`--- Issue #${i + 1} ---`)
    lines.push(`文件: ${item.issue.file}:${item.issue.line}`)
    lines.push(`规则: ${item.issue.rule}`)
    lines.push(`严重程度: ${item.issue.severity}`)
    lines.push(`信息: ${item.issue.message}`)
    lines.push(`代码片段: ${item.issue.snippet || '(无)'}`)
    lines.push('')
    lines.push('源码上下文:')
    lines.push(item.sourceContext)

    if (item.crossFileInfo) {
      lines.push('')
      lines.push('跨文件信息:')
      lines.push(item.crossFileInfo)
    }

    lines.push('')
  }

  return lines.join('\n')
}

// ==================== LLM 响应解析 ====================

function parseLlmResponse(
  rawContent: string,
  issues: IssueWithContext[],
): Map<number, LlmResponse> {
  const responses = new Map<number, LlmResponse>()

  // 尝试从每个 issue 块中提取 JSON
  const blocks = rawContent.split(/--- Issue #\d+ ---/s)

  for (let i = 1; i < blocks.length && i - 1 < issues.length; i++) {
    const block = blocks[i]
    if (!block) continue

    try {
      const jsonMatch = block.match(/\{[\s\S]*"verdict"\s*:[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          verdict: string
          reason: string
          enhancedMessage?: string
          enhancedSuggestion?: string
          enhancedSeverity?: string
        }
        responses.set(i - 1, {
          verdict: parsed.verdict as LlmResponse['verdict'],
          reason: parsed.reason,
          enhancedMessage: parsed.enhancedMessage,
          enhancedSuggestion: parsed.enhancedSuggestion,
          enhancedSeverity: parsed.enhancedSeverity as LlmResponse['enhancedSeverity'],
        })
      }
    } catch {
      // 解析失败
    }
  }

  // 未解析到的 issue 默认为 verified
  for (let i = 0; i < issues.length; i++) {
    if (!responses.has(i)) {
      responses.set(i, {
        verdict: 'verified',
        reason: 'LLM 未能解析响应，保守保留该 issue',
      })
    }
  }

  return responses
}
