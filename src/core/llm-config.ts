/**
 * AIDE - LLM 模型配置管理
 * 配置文件: ~/.aide/llm-config.json
 * 命令: aide configure model
 */

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import chalk from 'chalk'
import type { LlmModelConfig, LlmApiFormat } from '../types/index.js'

/** 用户配置目录 */
const AIDE_HOME = path.join(process.env.HOME || '', '.aide')
const CONFIG_FILE = path.join(AIDE_HOME, 'llm-config.json')

/** 支持的 API 格式列表 */
const API_FORMATS: { value: LlmApiFormat; label: string }[] = [
  { value: 'chat-completions', label: 'Chat Completions (/chat/completions)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages (/v1/messages)' },
  { value: 'responses', label: 'Responses API (/v1/responses)' },
]

/** 常见服务预设 */
const PRESETS: Array<{ name: string; baseUrl: string; apiFormat: LlmApiFormat; model: string }> = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com', apiFormat: 'chat-completions', model: 'gpt-4o-mini' },
  { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic-messages', model: 'claude-sonnet-4-20250514' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiFormat: 'chat-completions', model: 'glm-4-plus' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiFormat: 'chat-completions', model: 'qwen-plus' },
  { name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', apiFormat: 'chat-completions', model: 'abab6.5-chat' },
  { name: 'Ollama (本地)', baseUrl: 'http://localhost:11434', apiFormat: 'chat-completions', model: 'llama3' },
]

// ==================== 配置读写 ====================

/** 加载模型配置 */
export function loadModelConfigs(): Record<string, LlmModelConfig> {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {}
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8')
    return JSON.parse(content)
  } catch {
    return {}
  }
}

/** 保存模型配置 */
export function saveModelConfigs(configs: Record<string, LlmModelConfig>): void {
  fs.mkdirSync(AIDE_HOME, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf-8')
}

/** 获取单个模型配置 */
export function getModelConfig(name: string): LlmModelConfig | undefined {
  const configs = loadModelConfigs()
  return configs[name]
}

/** 列出所有已配置的模型 */
export function listModels(): LlmModelConfig[] {
  const configs = loadModelConfigs()
  return Object.values(configs)
}

/** 保存模型配置 */
export function saveModelConfig(config: LlmModelConfig): void {
  const configs = loadModelConfigs()
  configs[config.name] = config
  saveModelConfigs(configs)
}

/** 删除模型配置 */
export function deleteModelConfig(name: string): boolean {
  const configs = loadModelConfigs()
  if (!(name in configs)) return false
  delete configs[name]
  saveModelConfigs(configs)
  return true
}

// ==================== 交互式配置 ====================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()))
  })
}

async function selectFrom(prompt: string, options: Array<{ label: string; value: string }>): Promise<string> {
  console.log(prompt)
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]!.label}`)
  }
  const answer = await ask('  请选择 (输入序号): ')
  const idx = parseInt(answer, 10) - 1
  if (idx >= 0 && idx < options.length) return options[idx]!.value
  return options[0]!.value // 默认选第一个
}

export async function configureModelInteractive(): Promise<void> {
  console.log(chalk.bold('\n🤖 AIDE LLM 模型配置'))
  console.log('═'.repeat(50))
  console.log('配置一个自定义的 LLM 模型供应商\n')

  // 1. 名称
  const name = await ask('  模型名称 (如: 智谱 GLM): ')
  if (!name) {
    console.log(chalk.yellow('  名称不能为空，取消配置。'))
    return
  }

  // 2. 预设选择
  const presetOptions = [
    { label: '⊙ 手动输入（完全自定义）', value: 'custom' },
    ...PRESETS.map(p => ({ label: `◎ ${p.name}`, value: p.name })),
  ]

  const selectedPreset = await selectFrom('  选择预设模板（可选）:', presetOptions)

  let baseUrl = ''
  let apiFormat: LlmApiFormat = 'chat-completions'
  let model = ''

  if (selectedPreset === 'custom') {
    baseUrl = await ask('  Base URL: ')
    if (!baseUrl) baseUrl = 'https://api.example.com/v1'

    const formatOptions = API_FORMATS.map(f => ({ label: f.label, value: f.value }))
    apiFormat = await selectFrom('  API 格式:', formatOptions) as LlmApiFormat

    model = await ask('  模型名称: ')
    if (!model) model = 'gpt-4o-mini'
  } else {
    const preset = PRESETS.find(p => p.name === selectedPreset)!
    baseUrl = await ask(`  Base URL [${preset.baseUrl}]: `) || preset.baseUrl
    apiFormat = preset.apiFormat
    model = await ask(`  模型名称 [${preset.model}]: `) || preset.model
  }

  // 3. API Key
  const apiKey = await ask('  API Key: ')
  if (!apiKey) {
    console.log(chalk.red('  API Key 不能为空，取消配置。'))
    return
  }

  // 4. 超时
  const timeoutStr = await ask('  超时毫秒数 [30000]: ')
  const timeout = timeoutStr ? parseInt(timeoutStr, 10) : 30000

  // 5. 保存
  const config: LlmModelConfig = {
    name,
    baseUrl,
    apiKey,
    model,
    apiFormat,
    timeout,
  }

  saveModelConfig(config)
  console.log(chalk.green(`\n✓ 模型 "${name}" 已保存至 ${CONFIG_FILE}`))
  console.log(`  URL:    ${baseUrl}`)
  console.log(`  模型:   ${model}`)
  console.log(`  格式:   ${apiFormat}`)
}

// ==================== 列出模型 ====================

export function listModelsInteractive(): void {
  const configs = loadModelConfigs()
  const entries = Object.values(configs)

  if (entries.length === 0) {
    console.log(chalk.yellow('\n未配置任何 LLM 模型。'))
    console.log('使用 "aide configure model" 添加模型。\n')
    return
  }

  console.log(chalk.bold('\n📋 已配置的 LLM 模型\n'))

  for (const cfg of entries) {
    const maskKey = cfg.apiKey.length > 6
      ? cfg.apiKey.slice(0, 4) + '****' + cfg.apiKey.slice(-2)
      : '****'
    console.log(chalk.cyan(`  ${cfg.name}`))
    console.log(`    URL:    ${cfg.baseUrl}`)
    console.log(`    模型:   ${cfg.model}`)
    console.log(`    格式:   ${cfg.apiFormat}`)
    console.log(`    API Key: ${maskKey}`)
    console.log('')
  }
}
