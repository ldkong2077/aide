/**
 * AIDE - 扫描调度器
 * 注册检测器 → 遍历文件 → 调用检测器 → 收集 Issue
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { glob } from 'glob'
import type { Detector, DetectorContext, Issue, Language, ScanResult, ScanOptions, Severity, Category, Confidence, AideIgnoreConfig } from '../types/index.js'
import { detectLanguage } from '../core/parser.js'
import { RegistryClient } from '../core/registry-client.js'
import { parseAST } from '../core/ast-parser.js'
import { parsePythonAST, isPythonAvailable } from '../core/python-ast-bridge.js'
import { buildProjectSymbolIndex } from '../core/module-resolver.js'
import { buildCodeGraph } from '../core/code-graph.js'
import type { ProjectSymbolIndex } from '../types/index.js'
import { LlmCache } from './llm-cache.js'
import { batchIssues, extractSourceContext, formatCrossFileInfo } from './llm-batcher.js'
import { createLlmProvider, shouldReviewByLevel } from './llm-factory.js'
import { localPrefilter } from './local-prefilter.js'
import type { LlmResponse, IssueWithContext } from './llm-types.js'

/** 默认忽略的目录 */
const DEFAULT_IGNORE = [
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '.codegraph', '.aide', 'target',
  'vendor', 'pods', 'carthage', '__pycache__', '.venv', 'venv',
  '.tox', '.mypy_cache', '.pytest_cache', '_archive',
  'data', 'constants',   // 数据/常量目录中的 .ts/.py 文件是规则定义，不是可执行代码
]

/** 构建产物文件名模式（匹配的文件跳过扫描，这些不是用户手写源码） */
const BUILT_FILE_PATTERNS = [
  /\.min\.(js|css|mjs)$/,          // 压缩产物：echarts.min.js, style.min.css
  /\.bundle\.(js|mjs|css)$/,       // 打包产物：calc-engine.bundle.js
  /\.chunk\.(js|mjs|css)$/,        // 代码分割产物：vendor.chunk.js
  /\.d\.ts$/,                       // 类型声明（自动生成）
  /\.generated\.(ts|js|mjs)$/,     // 代码生成产物
  /\.map$/,                         // Source Map
]

/** 支持扫描的文件扩展名 */
const CODE_EXTENSIONS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.go',
  '.java', '.rs', '.rb', '.php',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh',
  '.kt', '.kts', '.swift', '.cs',
])

/** 文件内容缓存（扫描期间复用） */
interface FileCacheEntry {
  source: string
  language: Language
}

export class Scanner {
  private detectors: Detector[] = []
  /** 文件内容缓存：绝对路径 → 源码和语言 */
  private fileCache = new Map<string, FileCacheEntry>()

  /** 注册检测器 */
  register(detector: Detector): void {
    this.detectors.push(detector)
  }

  /** 注册多个检测器 */
  registerAll(detectors: Detector[]): void {
    for (const d of detectors) {
      this.detectors.push(d)
    }
  }

  /** 获取已注册的检测器列表 */
  getDetectors(): Detector[] {
    return [...this.detectors]
  }

  /** 扫描项目 */
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const projectPath = path.resolve(options.projectPath || process.cwd())
    const ignore = [...DEFAULT_IGNORE, ...(options.ignore || [])]

    // 加载 .aide/ignore-patterns.json 配置
    const aideConfig = await loadAideConfig(projectPath)

    // 合并 CLI --skip 和配置文件中的 ignoreRules
    const effectiveSkip = [...(options.skip || []), ...(aideConfig.ignoreRules || [])]

    // 确定启用的检测器
    const enabledDetectors = this.detectors.filter(d => {
      if (options.only && options.only.length > 0) {
        return options.only.includes(d.rule)
      }
      if (effectiveSkip.length > 0) {
        return !effectiveSkip.includes(d.rule)
      }
      return true
    })

    // 收集文件
    const files = await this.collectFiles(projectPath, ignore, options.file)
    const issues: Issue[] = []

    // ===== 第1遍：构建项目级符号索引（跨文件引用） =====
    let projectSymbols: ProjectSymbolIndex | undefined
    let codeGraph: import('../core/code-graph.js').CodeGraph | undefined
    {
      const fileData: Array<{ filePath: string; language: Language; source: string }> = []
      for (const filePath of files) {
        const relativePath = path.relative(projectPath, filePath)
        try {
          const source = await fs.readFile(filePath, 'utf-8')
          const language = detectLanguage(filePath)
          if (language !== 'unknown') {
            fileData.push({ filePath: relativePath, language, source })
            // 缓存文件内容供 LLM 复核使用
            this.fileCache.set(filePath, { source, language })
          }
        } catch {
          // 文件读取失败，跳过
        }
      }
      projectSymbols = buildProjectSymbolIndex(fileData)
      codeGraph = buildCodeGraph(fileData)
    }

    // ===== 第2遍：逐文件扫描 =====
    const pythonAvailable = isPythonAvailable()

    for (const filePath of files) {
      const relativePath = path.relative(projectPath, filePath)
      try {
        const fileEntry = this.fileCache.get(filePath)
        if (!fileEntry) continue
        const source = fileEntry.source
        const language = fileEntry.language

        if (language === 'unknown') continue

        // Python AST 桥接
        let pythonAst = undefined
        if (language === 'python' && pythonAvailable) {
          pythonAst = parsePythonAST(source)
        }

        const ctx: DetectorContext = {
          filePath: relativePath,
          source,
          language,
          projectPath,
          ast: parseAST(source, language),
          ...(pythonAst ? { pythonAst } : {}),
          ...(projectSymbols ? { projectSymbols } : {}),
          ...(codeGraph ? { codeGraph } : {}),
        }

        for (const detector of enabledDetectors) {
          try {
            const found = detector.detect(ctx)
            for (const issue of found) {
              if (!issue.confidence) {
                issue.confidence = 'medium'
              }
              if (!issue.snippet && issue.line > 0) {
                issue.snippet = extractLine(source, issue.line)
              }
            }
            issues.push(...found)
          } catch (err) {
            console.error(`[AIDE] 检测器 ${detector.rule} 在 ${relativePath} 出错:`, err)
          }
        }
      } catch {
        // 文件读取失败，跳过
      }
    }

    // 按 .aide/ignore-patterns.json 过滤
    const filteredIssues = filterByConfig(issues, aideConfig)

    // 在线注册表验证
    if (!options.offline) {
      const registryClient = new RegistryClient({
        timeout: options.registryTimeout,
        projectPath: options.projectPath,
      })

      const pkgIssues = filteredIssues.filter(
        i => i.rule === 'package-hallucination'
          && i.meta?.packageName
          && i.meta?.importType !== 'relative',
      )

      if (pkgIssues.length > 0) {
        const packages = pkgIssues.map(i => ({
          name: i.meta!.packageName,
          language: i.meta!.language as Language,
        }))

        const confirmed = await registryClient.batchCheck(packages)

        for (let i = filteredIssues.length - 1; i >= 0; i--) {
          const issue = filteredIssues[i]
          if (issue.meta?.packageName && issue.meta?.importType !== 'relative') {
            const key = `${issue.meta.language}:${issue.meta.packageName}`
            if (confirmed.has(key)) {
              filteredIssues.splice(i, 1)
            }
          }
        }
      }
    }

    const confidenceOrder: Record<Confidence, number> = {
      high: 0, medium: 1, low: 2,
    }
    const minConfidence = options.minConfidence || 'medium'
    const confidenceFilteredIssues = filteredIssues.filter(
      issue => confidenceOrder[issue.confidence || 'medium'] <= confidenceOrder[minConfidence]
    )

    // ===== LLM 复核步骤 =====
    let finalIssues = confidenceFilteredIssues
    const llmStats = { reviewed: 0, removed: 0, enhanced: 0 }

    // 自动模式：如果配置了 LLM 则自动启用 reduce-fp
    let llmMode = options.llm?.mode
    if (options.auto && (!llmMode || llmMode === 'off')) {
      // 检查是否有配置的 LLM 模型（通过命令行参数或配置文件）
      if (options.llm?.modelName || options.llm?.mode) {
        llmMode = 'reduce-fp'
      }
    }

    if (llmMode && llmMode !== 'off') {
      try {
        const llmResult = await this.runLlmReview(
          confidenceFilteredIssues,
          { ...options, llm: { ...options.llm, mode: llmMode } },
          projectSymbols,
          codeGraph,
        )
        finalIssues = llmResult.issues
        llmStats.reviewed = llmResult.reviewed
        llmStats.removed = llmResult.removed
        llmStats.enhanced = llmResult.enhanced

        // 在 reduce-fp 模式下，排除低置信度的低严重度问题（减少误报）
        // 但保留高/中置信度的低严重度问题（如安全问题降级为 low 但高置信）
        if (llmMode === 'reduce-fp') {
          finalIssues = finalIssues.filter(issue =>
            !(issue.severity === 'low' && (issue.confidence === 'low' || !issue.confidence))
            && !(issue.severity === 'info')
          )
        }
      } catch (err) {
        if (options.llm?.fallback !== false) {
          console.error(`[AIDE] LLM 复核失败，保留所有检测结果:`, err)
        } else {
          throw err
        }
      }
    }

    // 严格模式：只报告 high 和 medium 级别问题
    if (options.strict) {
      finalIssues = finalIssues.filter(issue => 
        issue.severity === 'high' || issue.severity === 'medium' || issue.severity === 'critical'
      )
    }

    // 按严重程度与置信度排序
    const severityOrder: Record<Severity, number> = {
      critical: 0, high: 1, medium: 2, low: 3, info: 4,
    }
    finalIssues.sort((a, b) => {
      const se = severityOrder[a.severity] - severityOrder[b.severity]
      if (se !== 0) return se
      const co = confidenceOrder[a.confidence || 'medium'] - confidenceOrder[b.confidence || 'medium']
      if (co !== 0) return co
      return a.file.localeCompare(b.file) || a.line - b.line
    })

    // 统计
    const bySeverity = {} as Record<Severity, number>
    const byConfidence = {} as Record<Confidence, number>
    const byCategory = {} as Record<Category, number>
    for (const issue of finalIssues) {
      bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1
      byConfidence[issue.confidence || 'medium'] = (byConfidence[issue.confidence || 'medium'] || 0) + 1
      byCategory[issue.category] = (byCategory[issue.category] || 0) + 1
    }

    return {
      timestamp: Date.now(),
      projectPath,
      issues: finalIssues,
      stats: {
        total: finalIssues.length,
        bySeverity,
        byConfidence,
        byCategory,
        filesScanned: files.length,
        llmReview: llmStats.reviewed > 0 ? {
          reviewed: llmStats.reviewed,
          removed: llmStats.removed,
          enhanced: llmStats.enhanced,
          reductionRate: llmStats.reviewed > 0
            ? Math.round((llmStats.removed / llmStats.reviewed) * 100)
            : 0,
        } : undefined,
      },
    }
  }

  /** 收集项目中的代码文件 */
  private async collectFiles(
    projectPath: string,
    ignore: string[],
    singleFile?: string,
  ): Promise<string[]> {
    if (singleFile) {
      const resolved = path.resolve(singleFile)
      const exists = await fs.access(resolved).then(() => true).catch(() => false)
      return exists ? [resolved] : []
    }

    const pattern = '**/*'
    const ignorePatterns = ignore.map(d =>
      d.includes('/') || d.includes('\\')
        ? `${d.replace(/\\/g, '/')}/**`
        : `**/${d}/**`
    )

    const files = await glob(pattern, {
      cwd: projectPath,
      absolute: true,
      ignore: ignorePatterns,
      nodir: true,
    })

    return files.filter(f => {
      const ext = path.extname(f).toLowerCase()
      if (!CODE_EXTENSIONS.has(ext)) return false
      // 跳过构建产物文件（压缩/打包/生成文件，不是用户源码）
      if (BUILT_FILE_PATTERNS.some(p => p.test(f))) return false
      return true
    })
  }

  // ==================== LLM 复核 ====================

  private async runLlmReview(
    issues: Issue[],
    options: ScanOptions,
    projectSymbols?: ProjectSymbolIndex,
    codeGraph?: import('../core/code-graph.js').CodeGraph,
  ): Promise<{ issues: Issue[]; reviewed: number; removed: number; enhanced: number }> {
    const llmOpts = options.llm!
    if (!llmOpts.mode || llmOpts.mode === 'off') {
      return { issues, reviewed: 0, removed: 0, enhanced: 0 }
    }

    // 创建 Provider
    const provider = createLlmProvider(llmOpts.modelName)
    if (!provider) {
      return { issues, reviewed: 0, removed: 0, enhanced: 0 }
    }

    // 确定需要复核的检测器列表（使用分级策略替代硬编码列表）
    const customReviewDetectors = llmOpts.reviewDetectors
      ? new Set(llmOpts.reviewDetectors)
      : null

    // 使用本地预筛先排除明显误报（0 token 消耗）
    const { filtered: prefilteredIssues, removed: prefilteredRemoved } = localPrefilter(issues)
    if (prefilteredRemoved > 0) {
      // 预筛移除的 issue 不计入 LLM 统计
    }

    // 使用分级策略过滤出需要 LLM 复核的 issues
    const targetIssues = prefilteredIssues.filter(i => {
      // 如果用户指定了自定义复核列表，使用旧逻辑
      if (customReviewDetectors) {
        return customReviewDetectors.has(i.rule)
      }
      // 否则使用分级策略
      return shouldReviewByLevel(i.rule, i.severity, i.confidence || 'medium')
    })
    if (targetIssues.length === 0) {
      return { issues, reviewed: 0, removed: 0, enhanced: 0 }
    }

    // 创建缓存
    const cacheEnabled = llmOpts.cacheEnabled !== false
    const cache = cacheEnabled ? new LlmCache({
      diskTtlMs: (llmOpts.cacheTtlHours || 24) * 60 * 60 * 1000,
    }) : null

    // 构建 IssueWithContext 列表
    const withContext: IssueWithContext[] = []
    const cacheKeys: string[] = []

    for (const issue of targetIssues) {
      // 从文件缓存中获取源码
      const absPath = path.resolve(options.projectPath || process.cwd(), issue.file)
      const fileEntry = this.fileCache.get(absPath)
      const source = fileEntry?.source || ''
      const context = extractSourceContext(source, issue.line, issue.severity, issue.rule)
      const crossFileInfo = formatCrossFileInfo(
        issue.file, issue.rule, issue.message,
        projectSymbols, codeGraph,
      )

      const sourceHash = LlmCache.makeSourceHash(source, issue.rule)
      const cacheKey = LlmCache.makeKey({
        fileHash: sourceHash,
        rule: issue.rule,
        provider: provider.name,
        model: provider.model,
        line: issue.line,
      })
      cacheKeys.push(cacheKey)

      withContext.push({ issue, sourceContext: context, crossFileInfo })
    }

    // 检查缓存命中
    const cachedResponses = new Map<number, LlmResponse>()
    if (cache) {
      for (let i = 0; i < withContext.length; i++) {
        const entry = await cache.get(cacheKeys[i]!)
        if (entry) {
          cachedResponses.set(i, entry.response)
        }
      }
    }

    // 准备需要 LLM 调度的批次
    const uncachedIndices = withContext
      .map((_, i) => i)
      .filter(i => !cachedResponses.has(i))

    if (uncachedIndices.length > 0) {
      const uncachedItems = uncachedIndices.map(i => withContext[i]!)

      // 批处理
      const { batches } = batchIssues(uncachedItems, {
        batchSize: llmOpts.batchSize || 10,
        maxConcurrency: llmOpts.maxConcurrency || 3,
      })

      // 并发调用 LLM
      const allResponses = new Map<number, LlmResponse>()

      for (const batch of batches) {
        try {
          const batchResults = await provider.reviewBatch(batch)
          for (const [localIdx, resp] of batchResults) {
            // 找到全局索引
            const globalIdx = uncachedIndices.find(ui => uncachedItems[ui] === batch[localIdx])
            if (globalIdx !== undefined) {
              allResponses.set(globalIdx, resp)
            }
          }
        } catch (err) {
          console.error(`[AIDE] LLM 批处理失败:`, err)
          for (const idx of uncachedIndices) {
            if (!allResponses.has(idx) && !cachedResponses.has(idx)) {
              allResponses.set(idx, { verdict: 'verified', reason: 'LLM 调用失败，保守保留' })
            }
          }
        }
      }

      // 合并缓存和 LLM 响应
      for (const [idx, resp] of allResponses) {
        cachedResponses.set(idx, resp)

        if (cache) {
          await cache.set({
            key: cacheKeys[idx]!,
            response: resp,
            timestamp: Date.now(),
            fileHash: '',
          })
        }
      }
    }

    // 应用 LLM 判定结果
    const finalIssues = [...issues]
    let removed = 0
    let enhanced = 0

    for (let i = 0; i < withContext.length; i++) {
      const resp = cachedResponses.get(i)
      if (!resp) continue

      const issue = withContext[i]!.issue
      const issueIndex = finalIssues.findIndex(fi => fi === issue)
      if (issueIndex === -1) continue

      // 更新 llmMeta
      finalIssues[issueIndex]!.llmMeta = {
        modelName: provider.name,
        verdict: resp.verdict,
        reason: resp.reason,
      }

      if (resp.verdict === 'false_positive') {
        finalIssues.splice(issueIndex, 1)
        removed++
      } else if (resp.verdict === 'enhanced') {
        if (resp.enhancedMessage) finalIssues[issueIndex]!.message = resp.enhancedMessage
        if (resp.enhancedSuggestion) finalIssues[issueIndex]!.suggestion = resp.enhancedSuggestion
        if (resp.enhancedSeverity) finalIssues[issueIndex]!.severity = resp.enhancedSeverity
        enhanced++
      }
    }

    return {
      issues: finalIssues,
      reviewed: targetIssues.length,
      removed,
      enhanced,
    }
  }
}

/** 提取指定行的代码 */
function extractLine(source: string, line: number): string {
  const lines = source.split('\n')
  if (line < 1 || line > lines.length) return ''
  return lines[line - 1].trim()
}

/** 加载 .aide/ignore-patterns.json 配置文件 */
async function loadAideConfig(projectPath: string): Promise<AideIgnoreConfig> {
  const configPath = path.join(projectPath, '.aide', 'ignore-patterns.json')
  try {
    const content = await fs.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    return {
      ignoreRules: Array.isArray(parsed.ignoreRules) ? parsed.ignoreRules : [],
      ignorePaths: Array.isArray(parsed.ignorePaths) ? parsed.ignorePaths : [],
      ignoreIssues: Array.isArray(parsed.ignoreIssues) ? parsed.ignoreIssues : [],
    }
  } catch {
    return { ignoreRules: [], ignorePaths: [], ignoreIssues: [] }
  }
}

/** 按 .aide/ignore-patterns.json 配置过滤 issue */
function filterByConfig(issues: Issue[], config: AideIgnoreConfig): Issue[] {
  if (!config.ignoreRules?.length && !config.ignorePaths?.length && !config.ignoreIssues?.length) {
    return issues
  }

  const pathPatterns = config.ignorePaths || []

  return issues.filter(issue => {
    if (config.ignoreRules?.length && config.ignoreRules.includes(issue.rule)) {
      return false
    }

    if (pathPatterns.length) {
      const normalizedFile = issue.file.replace(/\\/g, '/')
      for (const pattern of pathPatterns) {
        const normalizedPattern = pattern.replace(/\\/g, '/')
        if (normalizedFile.includes(normalizedPattern) || matchGlob(normalizedFile, normalizedPattern)) {
          return false
        }
      }
    }

    if (config.ignoreIssues?.length) {
      for (const ignore of config.ignoreIssues) {
        if (ignore.rule === issue.rule && ignore.file === issue.file) {
          if (ignore.line === undefined || ignore.line === issue.line) {
            return false
          }
        }
      }
    }

    return true
  })
}

/** 简单 glob 匹配（支持 * 通配符） */
function matchGlob(str: string, pattern: string): boolean {
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return regex.test(str)
}
