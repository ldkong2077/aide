/**
 * aide scan / aide check / aide scan-llm 命令
 */

import { Command } from 'commander'
import * as path from 'path'
import * as fs from 'fs'
import ora from 'ora'
import chalk from 'chalk'
import { Scanner } from '../../core/scanner.js'
import { formatReport } from '../../core/reporter.js'
import { createDetectors, createPreviewDetectors } from '../../detectors/index.js'
import { loadAideRc } from '../../core/config.js'
import type { Confidence, ScanOptions } from '../../types/index.js'

/**
 * aide scan — 纯本地扫描，0 token 消耗
 */
export function scanCommand(): Command {
  const cmd = new Command('scan')

  cmd
    .description('扫描项目，检测代码问题（纯本地，无需 LLM）')
    .argument('[path]', '要扫描的项目路径（默认当前目录）')
    .option('-p, --project <path>', '项目路径（覆盖位置参数）')
    .option('-f, --file <file>', '只扫描指定文件')
    .option('--format <format>', '输出格式: default, verbose, ai, json, supervisor', 'default')
    .option('--lang <lang>', '输出语言: zh-CN, en', 'zh-CN')
    .option('--only <rules>', '只启用指定检测器（逗号分隔）')
    .option('--skip <rules>', '禁用指定检测器（逗号分隔）')
    .option('--ignore <dirs>', '忽略的目录（逗号分隔）')
    .option('--exit-code', '发现问题时以退出码 1 退出（适用于 CI/脚本）')
    .option('--offline', '禁用网络请求（在线注册表验证等）')
    .option('--preview', '启用预览模式（包含不稳定的检测器，如 dead-code）')
    .option('--min-confidence <level>', '最低置信度: high, medium, low', 'low')
    .option('--strict', '严格模式：只报告 high 和 medium 级别问题')
    .option('--registry-timeout <ms>', '注册表查询超时毫秒数（默认 5000）')
    .action(async (target: string | undefined, opts) => {
      const projectPath = path.resolve(opts.project || target || '.')
      const rc = loadAideRc(projectPath)

      // 合并配置：CLI 显式设置 > .aiderc.json > 默认值
      const options: ScanOptions = {
        projectPath,
        file: opts.file,
        format: (opts.format !== 'default' ? opts.format : rc.format) || 'default',
        lang: (opts.lang !== 'zh-CN' ? opts.lang : rc.lang) || 'zh-CN',
        only: opts.only ? opts.only.split(',') : undefined,
        skip: opts.skip ? opts.skip.split(',') : rc.skipRules,
        ignore: opts.ignore ? opts.ignore.split(',') : rc.ignore,
        offline: opts.offline ?? rc.offline ?? false,
        preview: opts.preview ?? rc.preview ?? false,
        strict: opts.strict ?? rc.strict ?? false,
        minConfidence: (opts.minConfidence !== 'low' ? parseConfidence(opts.minConfidence) : rc.minConfidence) || 'low',
        registryTimeout: opts.registryTimeout ? parseInt(opts.registryTimeout, 10) : rc.registryTimeout,
      }

      const scanner = new Scanner()
      scanner.registerAll(createDetectors())
      if (options.preview) {
        scanner.registerAll(createPreviewDetectors())
      }

      const detectorCount = scanner.getDetectors().length
      const spinner = ora({
        text: `正在扫描 (${detectorCount} 个检测器)...`,
        isSilent: !process.stdout.isTTY,
      }).start()

      try {
        const result = await scanner.scan(options)
        spinner.stop()

        const output = formatReport(result, options.format, options.lang)
        console.log(output)

        if (opts.exitCode && result.issues.length > 0) {
          process.exit(1)
        }
      } catch (err) {
        spinner.stop()
        console.error(chalk.red('扫描失败:'), err)
        process.exit(1)
      }
    })

  return cmd
}

/**
 * aide scan-llm — LLM 辅助精准扫描
 * 需先运行 aide configure-llm 配置模型
 */
export function scanLlmCommand(): Command {
  const cmd = new Command('scan-llm')

  cmd
    .description('LLM 辅助精准扫描 — 先本地检测，再用 LLM 复核过滤误报')
    .argument('[path]', '要扫描的项目路径（默认当前目录）')
    .option('-p, --project <path>', '项目路径（覆盖位置参数）')
    .option('--format <format>', '输出格式: default, verbose, ai, json, supervisor', 'supervisor')
    .option('--lang <lang>', '输出语言: zh-CN, en', 'zh-CN')
    .option('--ignore <dirs>', '忽略的目录（逗号分隔）')
    .option('--exit-code', '发现问题时以退出码 1 退出（适用于 CI/脚本）')
    .option('--offline', '禁用网络请求')
    .option('--model <name>', '已配置的 LLM 模型名称（用 "aide configure-llm model" 配置）')
    .option('--batch-size <n>', 'LLM 批次大小（默认 10）', '10')
    .option('--max-concurrency <n>', 'LLM 最大并发数（默认 3）', '3')
    .option('--no-llm-fallback', 'LLM 失败时不保留所有结果（默认保留）')
    .option('--preview', '启用预览模式（包含不稳定的检测器）')
    .action(async (target: string | undefined, opts) => {
      const projectPath = path.resolve(opts.project || target || '.')
      const rc = loadAideRc(projectPath)

      // 合并配置：CLI 显式设置 > .aiderc.json > 默认值
      const options: ScanOptions = {
        projectPath,
        format: (opts.format !== 'supervisor' ? opts.format : rc.format) || 'supervisor',
        lang: (opts.lang !== 'zh-CN' ? opts.lang : rc.lang) || 'zh-CN',
        ignore: opts.ignore ? opts.ignore.split(',') : rc.ignore,
        offline: opts.offline ?? rc.offline ?? false,
        preview: opts.preview ?? rc.preview ?? false,
        llm: {
          mode: 'reduce-fp',
          modelName: opts.model || rc.defaultLlmModel,
          batchSize: (opts.batchSize && opts.batchSize !== '10' ? parseInt(opts.batchSize, 10) : rc.llmBatchSize) || 10,
          maxConcurrency: (opts.maxConcurrency && opts.maxConcurrency !== '3' ? parseInt(opts.maxConcurrency, 10) : rc.llmMaxConcurrency) || 3,
          fallback: opts.llmFallback !== false,
        },
      }

      const scanner = new Scanner()
      scanner.registerAll(createDetectors())
      if (options.preview) {
        scanner.registerAll(createPreviewDetectors())
      }

      const spinner = ora({
        text: '正在扫描（LLM 辅助模式）...',
        isSilent: !process.stdout.isTTY,
      }).start()

      try {
        const result = await scanner.scan(options)
        spinner.stop()

        const output = formatReport(result, options.format, options.lang)
        console.log(output)

        if (opts.exitCode && result.issues.length > 0) {
          process.exit(1)
        }
      } catch (err) {
        spinner.stop()
        console.error(chalk.red('扫描失败:'), err)
        process.exit(1)
      }
    })

  return cmd
}

/**
 * aide check — 单文件快速检查
 */
export function checkCommand(): Command {
  const cmd = new Command('check')

  cmd
    .description('检查指定文件的代码问题')
    .argument('<file>', '要检查的文件路径')
    .option('-p, --project <path>', '项目路径（默认为文件所在目录）')
    .option('--format <format>', '输出格式: default, verbose, ai, json', 'default')
    .option('--lang <lang>', '输出语言: zh-CN, en', 'zh-CN')
    .option('--only <rules>', '只启用指定检测器（逗号分隔）')
    .option('--skip <rules>', '禁用指定检测器（逗号分隔）')
    .option('--min-confidence <level>', '最低置信度: high, medium, low', 'low')
    .option('--exit-code', '发现问题时以退出码 1 退出（适用于 CI/脚本）')
    .option('--offline', '禁用网络请求（在线注册表验证等）')
    .action(async (file: string, opts) => {
      const projectPath = opts.project || findProjectRoot(file)
      const options: ScanOptions = {
        projectPath,
        file,
        format: opts.format,
        lang: opts.lang,
        only: opts.only ? opts.only.split(',') : undefined,
        skip: opts.skip ? opts.skip.split(',') : undefined,
        offline: opts.offline ?? false,
        minConfidence: parseConfidence(opts.minConfidence),
      }

      const scanner = new Scanner()
      scanner.registerAll(createDetectors())

      const spinner = ora({
        text: `正在检查 ${file}...`,
        isSilent: !process.stdout.isTTY,
      }).start()

      try {
        const result = await scanner.scan(options)
        spinner.stop()

        const output = formatReport(result, options.format, options.lang)
        console.log(output)

        if (opts.exitCode && result.issues.length > 0) {
          process.exit(1)
        }
      } catch (err) {
        spinner.stop()
        console.error(chalk.red('检查失败:'), err)
        process.exit(1)
      }
    })

  return cmd
}

function parseConfidence(value: string | undefined): Confidence | undefined {
  if (!value) return undefined
  if (value === 'high' || value === 'medium' || value === 'low') return value
  throw new Error(`无效的置信度: ${value}，可选值为 high, medium, low`)
}

/** 项目根目录的标识文件，任一存在即认为是项目根 */
const PROJECT_ROOT_MARKERS = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  '.git',
]

/**
 * 从指定文件路径向上查找项目根目录。
 * 找到包含项目标识文件的最近目录；若找不到，回退到文件所在目录。
 */
function findProjectRoot(file: string): string {
  const resolved = path.resolve(file)
  let dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? resolved
    : path.dirname(resolved)

  while (true) {
    if (PROJECT_ROOT_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break  // 到达文件系统根
    dir = parent
  }
  // 找不到标识文件，回退到文件所在目录
  return path.dirname(path.resolve(file))
}
