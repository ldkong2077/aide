/**
 * AIDE - LLM Provider 工厂
 * 从 ~/.aide/llm-config.json 加载模型配置，创建通用 HTTP 客户端
 */

import type { LLMProvider } from './llm-types.js'
import { GenericLlmProvider } from './llm-client.js'
import { getModelConfig } from './llm-config.js'
import type { Severity, Confidence } from '../types/index.js'

/**
 * 根据模型名称创建 LLM Provider。
 * 从 ~/.aide/llm-config.json 加载配置。
 * 如果模型不存在，返回 null（优雅降级）。
 */
export function createLlmProvider(modelName?: string): LLMProvider | null {
  if (!modelName) return null

  const config = getModelConfig(modelName)
  if (!config) {
    console.error(`[AIDE] 未找到模型配置: "${modelName}"`)
    console.error(`[AIDE] 使用 "aide configure-llm model" 添加模型，或通过环境变量 AIDE_LLM_MODEL_NAME 指定`)
    return null
  }

  return new GenericLlmProvider({
    name: config.name,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    apiFormat: config.apiFormat,
    timeout: config.timeout,
  })
}

// ==================== LLM 复核分级策略 ====================

/** 复核优先级 */
export type ReviewPriority = 'must' | 'should' | 'optional'

/** 检测器的复核分级配置 */
export interface ReviewLevelConfig {
  /** 检测器规则名 */
  rule: string
  /** 复核优先级 */
  priority: ReviewPriority
  /** 该检测器在 must 优先级下：所有 severity 都送 LLM */
  mustSeverities?: Severity[]
  /** 该检测器在 should 优先级下：仅指定 severity 送 LLM */
  shouldSeverities?: Severity[]
  /** 该检测器在 optional 优先级下：仅指定 severity + confidence 送 LLM */
  optionalSeverities?: Severity[]
  optionalConfidences?: Confidence[]
}

/**
 * LLM 复核分级策略表
 *
 * | 优先级 | 含义 | 默认行为 |
 * |--------|------|----------|
 * | must   | 必须复核 | 所有 severity 都送 LLM |
 * | should | 建议复核 | 仅 high/medium 送 LLM |
 * | optional | 可选复核 | 仅 high+confidence:high 送 LLM |
 */
const REVIEW_LEVELS: ReviewLevelConfig[] = [
  // ===== 必须复核（核心 AI 幻觉检测） =====
  {
    rule: 'api-hallucination',
    priority: 'must',
  },
  {
    rule: 'package-hallucination',
    priority: 'must',
  },

  // ===== 建议复核（AI 代码模式，中等误报率） =====
  {
    rule: 'stub-function',
    priority: 'should',
    shouldSeverities: ['critical', 'high', 'medium'],
  },
  {
    rule: 'empty-impl',
    priority: 'should',
    shouldSeverities: ['critical', 'high', 'medium'],
  },
  {
    rule: 'fake-url',
    priority: 'should',
    shouldSeverities: ['critical', 'high', 'medium'],
  },
  {
    rule: 'security',
    priority: 'should',
    shouldSeverities: ['critical', 'high', 'medium'],
  },

  // ===== 可选复核（高误报率或低价值） =====
  {
    rule: 'unused-declaration',
    priority: 'optional',
    optionalSeverities: ['critical', 'high'],
    optionalConfidences: ['high'],
  },
  {
    rule: 'weak-validation',
    priority: 'optional',
    optionalSeverities: ['critical', 'high'],
    optionalConfidences: ['high', 'medium'],
  },
  {
    rule: 'unhandled-promise',
    priority: 'optional',
    optionalSeverities: ['critical', 'high', 'medium'],
    optionalConfidences: ['high'],
  },
  {
    rule: 'swallowed-error',
    priority: 'optional',
    optionalSeverities: ['critical', 'high'],
    optionalConfidences: ['high'],
  },
  {
    rule: 'hardcoded-value',
    priority: 'optional',
    optionalSeverities: ['critical', 'high'],
    optionalConfidences: ['high'],
  },
  {
    rule: 'resource-leak',
    priority: 'optional',
    optionalSeverities: ['critical', 'high'],
    optionalConfidences: ['high'],
  },
]

/** 分级配置映射（按规则名索引） */
const REVIEW_LEVEL_MAP = new Map(REVIEW_LEVELS.map(l => [l.rule, l]))

/**
 * 判断一个 issue 是否需要送 LLM 复核（基于分级策略）
 *
 * @returns true 表示需要 LLM 复核
 */
export function shouldReviewByLevel(rule: string, severity: Severity, confidence: Confidence): boolean {
  const config = REVIEW_LEVEL_MAP.get(rule)
  if (!config) return false  // 不在分级表中的规则不送 LLM

  switch (config.priority) {
    case 'must':
      // 必须复核：所有 severity 都送
      return true

    case 'should': {
      // 建议复核：仅指定 severity 送
      const allowed = config.shouldSeverities || ['critical', 'high', 'medium']
      return allowed.includes(severity)
    }

    case 'optional': {
      // 可选复核：仅指定 severity + confidence 送
      const allowedSeverities = config.optionalSeverities || ['critical', 'high']
      const allowedConfidences = config.optionalConfidences || ['high']
      return allowedSeverities.includes(severity) && allowedConfidences.includes(confidence)
    }
  }
}

/**
 * 默认需要 LLM 复核的检测器列表（向后兼容）
 * @deprecated 使用 shouldReviewByLevel 替代
 */
export const DEFAULT_REVIEW_DETECTORS = REVIEW_LEVELS.map(l => l.rule)
