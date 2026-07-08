/**
 * AIDE - LLM 类型定义
 */

import type { Severity } from '../types/index.js'

// ==================== LLM 判定结果 ====================

/** LLM 对 issue 的判定 */
export type LlmVerdict = 'verified' | 'false_positive' | 'enhanced'

/** LLM 对单个 issue 的响应 */
export interface LlmResponse {
  verdict: LlmVerdict
  reason: string
  enhancedMessage?: string
  enhancedSuggestion?: string
  enhancedSeverity?: Severity
}

// ==================== 发送给 LLM 的数据结构 ====================

/** 带上下文的 Issue，用于发送给 LLM 分析 */
export interface IssueWithContext {
  /** 原始 issue */
  issue: import('../types/index.js').Issue
  /** 源码上下文（前后各 5 行） */
  sourceContext: string
  /** 跨文件引用信息（如有） */
  crossFileInfo?: string
}

// ==================== Provider 接口 ====================

/** LLM Provider 抽象接口 */
export interface LLMProvider {
  /** 提供者名称（用于日志和缓存 key） */
  readonly name: string
  /** 模型名称 */
  readonly model: string
  /** 复核一批 issue */
  reviewBatch(issues: IssueWithContext[]): Promise<Map<number, LlmResponse>>
  /** 健康检查 */
  healthCheck(): Promise<boolean>
}

// ==================== 缓存相关 ====================

/** 缓存条目 */
export interface CacheEntry {
  /** 缓存 key */
  key: string
  /** 响应数据 */
  response: LlmResponse
  /** 缓存时间戳（毫秒） */
  timestamp: number
  /** 文件内容 hash（用于 TTL 判断） */
  fileHash: string
}

/** 缓存统计信息 */
export interface CacheStats {
  /** 内存缓存命中次数 */
  memoryHits: number
  /** 磁盘缓存命中次数 */
  diskHits: number
  /** 缓存未命中次数 */
  misses: number
  /** 缓存条目总数 */
  size: number
}
