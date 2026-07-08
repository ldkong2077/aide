/**
 * AIDE - 配置文件管理
 * 读取 .aiderc.json，合并 CLI 参数
 * 优先级：CLI 参数 > .aiderc.json > 默认值
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Confidence } from '../types/index.js'

/** .aiderc.json 配置结构 */
export interface AideRcConfig {
  /** 忽略的目录（默认 node_modules, .git, dist, build, .aide） */
  ignore?: string[]
  /** 禁用的检测器规则名 */
  skipRules?: string[]
  /** 最低置信度 */
  minConfidence?: Confidence
  /** 严格模式 */
  strict?: boolean
  /** 禁用网络请求 */
  offline?: boolean
  /** 启用预览模式 */
  preview?: boolean
  /** 默认输出格式 */
  format?: 'default' | 'verbose' | 'ai' | 'json' | 'supervisor'
  /** 默认输出语言 */
  lang?: 'zh-CN' | 'en'
  /** 注册表查询超时（毫秒） */
  registryTimeout?: number
  /** LLM 默认模型名 */
  defaultLlmModel?: string
  /** LLM 批次大小 */
  llmBatchSize?: number
  /** LLM 最大并发数 */
  llmMaxConcurrency?: number
}

/** 配置文件搜索文件名 */
const CONFIG_FILES = ['.aiderc.json', '.aiderc', 'aide.config.json']

/**
 * 从项目目录向上查找配置文件
 * 返回合并后的配置（CLI 参数优先）
 */
export function loadAideRc(projectPath: string, cliOverrides?: Partial<AideRcConfig>): AideRcConfig {
  const rcConfig = findAndParseRc(projectPath)
  return mergeConfig(rcConfig, cliOverrides)
}

/** 向上查找 .aiderc.json */
function findAndParseRc(startDir: string): AideRcConfig {
  let dir = startDir
  const root = '/'

  while (true) {
    for (const filename of CONFIG_FILES) {
      const filePath = join(dir, filename)
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8')
          return JSON.parse(content) as AideRcConfig
        } catch {
          // 配置文件解析失败，忽略
        }
      }
    }
    if (dir === root) break
    const parent = join(dir, '..')
    if (parent === dir) break  // 已到根目录
    dir = parent
  }

  return {}
}

/** 合并配置：CLI 参数 > .aiderc.json > 默认值 */
function mergeConfig(rc: AideRcConfig, cli?: Partial<AideRcConfig>): AideRcConfig {
  const result: AideRcConfig = {}

  // 从 rc 配置开始
  if (rc.ignore) result.ignore = rc.ignore
  if (rc.skipRules) result.skipRules = rc.skipRules
  if (rc.minConfidence) result.minConfidence = rc.minConfidence
  if (rc.strict !== undefined) result.strict = rc.strict
  if (rc.offline !== undefined) result.offline = rc.offline
  if (rc.preview !== undefined) result.preview = rc.preview
  if (rc.format) result.format = rc.format
  if (rc.lang) result.lang = rc.lang
  if (rc.registryTimeout) result.registryTimeout = rc.registryTimeout
  if (rc.defaultLlmModel) result.defaultLlmModel = rc.defaultLlmModel
  if (rc.llmBatchSize) result.llmBatchSize = rc.llmBatchSize
  if (rc.llmMaxConcurrency) result.llmMaxConcurrency = rc.llmMaxConcurrency

  // CLI 参数覆盖（非 undefined 才覆盖）
  if (cli) {
    if (cli.ignore !== undefined) result.ignore = cli.ignore
    if (cli.skipRules !== undefined) result.skipRules = cli.skipRules
    if (cli.minConfidence !== undefined) result.minConfidence = cli.minConfidence
    if (cli.strict !== undefined) result.strict = cli.strict
    if (cli.offline !== undefined) result.offline = cli.offline
    if (cli.preview !== undefined) result.preview = cli.preview
    if (cli.format !== undefined) result.format = cli.format
    if (cli.lang !== undefined) result.lang = cli.lang
    if (cli.registryTimeout !== undefined) result.registryTimeout = cli.registryTimeout
    if (cli.defaultLlmModel !== undefined) result.defaultLlmModel = cli.defaultLlmModel
    if (cli.llmBatchSize !== undefined) result.llmBatchSize = cli.llmBatchSize
    if (cli.llmMaxConcurrency !== undefined) result.llmMaxConcurrency = cli.llmMaxConcurrency
  }

  return result
}
