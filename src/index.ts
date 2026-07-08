/**
 * AIDE - 公共 SDK 入口
 * 支持 `import { Scanner } from '@aide-dev/aide'` 编程式调用
 */

// 核心类
export { Scanner } from './core/scanner.js'
export { RegistryClient } from './core/registry-client.js'
export type { RegistryResult, RegistrySource } from './core/registry-client.js'

// 检测器工厂
export { createDetectors, createPreviewDetectors } from './detectors/index.js'

// 报告格式化
export { formatReport, formatDefault, formatVerbose, formatAI, formatJSON, formatSupervisor } from './core/reporter.js'

// 本地预筛
export { localPrefilter } from './core/local-prefilter.js'

// LLM 复核
export { createLlmProvider, shouldReviewByLevel } from './core/llm-factory.js'
export type { ReviewPriority, ReviewLevelConfig } from './core/llm-factory.js'

// 工具函数
export { getLineNumber, escapeRegex, extractBlockBody } from './core/utils.js'

// 类型
export type {
  Issue, Severity, Confidence, Category,
  Detector, DetectorContext, Language, ProjectSymbolIndex,
  ScanResult, ScanOptions,
  LlmModelConfig, LlmOptions, LlmApiFormat,
  AideIgnoreConfig,
} from './types/index.js'
export { isTestFile } from './types/index.js'
