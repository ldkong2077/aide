/**
 * AIDE - 核心类型定义
 * 扫描项目 → 输出问题清单（文件+行号+级别+描述）
 */

// ==================== 问题定义 ====================

/** 严重程度 */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** 检测置信度 */
export type Confidence = 'high' | 'medium' | 'low'

/** 检测类别 */
export type Category =
  | 'ai-code'        // AI 生成代码专项（第二层）
  | 'hallucination'  // 幻觉检测（第一层）
  | 'security'       // 安全问题
  | 'correctness'    // 正确性问题
  | 'consistency'    // 一致性问题（第三层，跨文件）
  | 'quality'        // 代码质量

/** 检测到的问题 */
export interface Issue {
  /** 规则名，如 stub-function（语义化，不用数字编码） */
  rule: string
  severity: Severity
  /** 检测置信度：高置信适合 CI 阻断，中/低置信适合人工审查 */
  confidence?: Confidence
  category: Category
  /** 文件相对路径 */
  file: string
  /** 行号（从 1 开始） */
  line: number
  /** 列号（可选） */
  col?: number
  /** 一句话描述 */
  message: string
  /** 出错行的代码 */
  snippet?: string
  /** 修复建议 */
  suggestion?: string
  /** 结构化元数据（供后处理使用，如在线注册表验证） */
  meta?: Record<string, string>
  /** 跨文件关联（第三层用） */
  related?: {
    file: string
    line: number
    message: string
  }
  /** LLM 复核元数据（可选，由 LLM 集成模块填充） */
  llmMeta?: {
    modelName: string
    verdict: 'verified' | 'false_positive' | 'enhanced'
    reason: string
  }
}

// ==================== 检测器接口 ====================

/** 支持的语言 */
export type Language =
  | 'python' | 'typescript' | 'javascript' | 'go'
  | 'java' | 'rust' | 'ruby' | 'php'
  | 'c' | 'cpp' | 'kotlin' | 'swift' | 'csharp'
  | 'unknown'

/** 检测器上下文 */
export interface DetectorContext {
  /** 文件相对路径 */
  filePath: string
  /** 源码文本 */
  source: string
  /** 语言类型 */
  language: Language
  /** 解析后的 AST（按语言不同类型不同，可选） */
  ast?: unknown
  /** Python AST 桥接结果（仅语言为 python 且 python3 可用时） */
  pythonAst?: import('../core/python-ast-bridge.js').PythonASTResult
  /** 项目根目录 */
  projectPath: string
  /** 跨文件符号索引（仅 enableCrossFile 时可用） */
  projectSymbols?: ProjectSymbolIndex
  /** 代码符号依赖图（仅 enableCrossFile 时可用，替换 projectSymbols） */
  codeGraph?: import('../core/code-graph.js').CodeGraph
}

/** 跨文件符号索引 */
export interface ProjectSymbolIndex {
  /** 项目中所有被其他文件引用的符号名集合 */
  referencedAcrossFiles: Set<string>
  /** 按文件路径索引的导出符号 */
  exportsByFile: Map<string, Set<string>>
  /** Python __init__.py 的重新导出 */
  reExports: Map<string, Set<string>>
}

/** 检测器接口 — 每个检测器必须实现 */
export interface Detector {
  /** 规则名，如 stub-function */
  rule: string
  /** 检测类别 */
  category: Category
  /** 检测什么 */
  description: string
  /** 默认严重程度 */
  severity: Severity
  /** 执行检测 */
  detect(ctx: DetectorContext): Issue[]
}

// ==================== 扫描结果 ====================

/** 扫描结果 */
export interface ScanResult {
  timestamp: number
  projectPath: string
  issues: Issue[]
  stats: {
    total: number
    bySeverity: Record<Severity, number>
    byConfidence: Record<Confidence, number>
    byCategory: Record<Category, number>
    filesScanned: number
    /** LLM 复核统计（仅当启用 LLM 模式时存在） */
    llmReview?: {
      reviewed: number
      removed: number
      enhanced: number
      reductionRate: number
    }
  }
}

// ==================== 公共工具函数 ====================

/** 判断文件是否为测试文件（所有检测器应统一跳过） */
export function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.(ts|js|jsx|tsx|py|go|rs|java|rb|php|c|cpp|cs|kt|swift)$/.test(filePath)
    || /(?:^|[/_])test[_/]/.test(filePath)       // test_xxx.py / xxx_test.go / test/ 目录
    || /(?:^|[/_])spec[_/]/.test(filePath)       // spec/ 目录
    || /_test\.(go|py)$/.test(filePath)          // Go/Python 测试文件
    || /__tests__\//.test(filePath)              // Jest __tests__ 目录
    || /[\\/]tests[\\/]/.test(filePath)          // tests/ 目录（含 conftest.py 等）
    || /[\\/]test[\\/]/.test(filePath)           // test/ 目录
}

// ==================== 扫描选项 ====================

/** LLM API 格式 */
export type LlmApiFormat = 'chat-completions' | 'anthropic-messages' | 'responses'

/** 已配置的 LLM 模型 */
export interface LlmModelConfig {
  /** 用户自定义名称，如 "智谱 GLM"、"通义千问" */
  name: string
  /** Base URL，如 https://open.bigmodel.cn/api/paas/v4 */
  baseUrl: string
  /** API Key */
  apiKey: string
  /** 模型名，如 glm-4-plus */
  model: string
  /** API 格式 */
  apiFormat: LlmApiFormat
  /** 超时毫秒数（默认 30000） */
  timeout?: number
}

/** LLM 集成运行时选项 */
export interface LlmOptions {
  /** LLM 模式: off | reduce-fp（误报过滤）| full（增强检测） */
  mode?: 'off' | 'reduce-fp' | 'full'
  /** 使用的模型名称（对应 LlmModelConfig.name） */
  modelName?: string
  /** 每批最大 issue 数（默认 10） */
  batchSize?: number
  /** 最大并发 LLM 调用数（默认 3） */
  maxConcurrency?: number
  /** 是否启用磁盘缓存（默认 true） */
  cacheEnabled?: boolean
  /** 缓存过期时间（小时，默认 24） */
  cacheTtlHours?: number
  /** LLM 失败时是否保留所有 issue（默认 true） */
  fallback?: boolean
  /** 需要 LLM 复核的检测器规则名列表 */
  reviewDetectors?: string[]
}

/** 扫描选项 */
export interface ScanOptions {
  /** 项目路径（默认当前目录） */
  projectPath?: string
  /** 只扫描指定文件 */
  file?: string
  /** 输出格式 */
  format?: 'default' | 'verbose' | 'ai' | 'json' | 'supervisor'
  /** 输出语言 */
  lang?: 'zh-CN' | 'en'
  /** 忽略的目录 */
  ignore?: string[]
  /** 启用的检测器（空=全部） */
  only?: string[]
  /** 禁用的检测器 */
  skip?: string[]
  /** 禁用网络请求（在线注册表验证等） */
  offline?: boolean
  /** 启用预览模式（包含不稳定的检测器，如 dead-code） */
  preview?: boolean
  /** 严格模式：只报告 high 和 medium 级别问题 */
  strict?: boolean
  /** 自动模式：如果配置了 LLM 则自动启用 reduce-fp */
  auto?: boolean
  /** 最低置信度过滤（high 只显示高置信；medium 显示高/中；low 显示全部） */
  minConfidence?: Confidence
  /** 注册表查询超时（毫秒，默认 5000） */
  registryTimeout?: number
  /** LLM 集成选项 */
  llm?: LlmOptions
}

/** .aide/ignore-patterns.json 配置 */
export interface AideIgnoreConfig {
  /** 全局禁用的检测器规则 */
  ignoreRules?: string[]
  /** 全局忽略的文件路径 glob 模式 */
  ignorePaths?: string[]
  /** 按文件+规则+行号精确忽略 */
  ignoreIssues?: Array<{
    file: string
    rule: string
    line?: number
  }>
}
