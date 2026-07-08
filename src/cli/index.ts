#!/usr/bin/env node
/**
 * AIDE CLI - AI coding quality inspector
 * 扫描项目 → 输出问题清单（文件+行号+级别+描述）
 *
 * 命令：
 *   aide scan [path]           纯本地扫描，0 token 消耗
 *   aide check <file>          单文件快速检查
 *   aide scan-llm [path]       LLM 辅助精准扫描
 *   aide configure-llm         配置 LLM（含本地模型）
 */

import { Command } from 'commander'
import { scanCommand, checkCommand, scanLlmCommand } from './commands/scan.js'
import { configureLlmCommand } from './commands/configure.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// 从 package.json 读取版本号
const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'))

const program = new Command()

program
  .name('aide')
  .description('AIDE - AI coding quality inspector')
  .version(pkg.version)

program.addCommand(scanCommand())
program.addCommand(checkCommand())
program.addCommand(scanLlmCommand())
program.addCommand(configureLlmCommand())

program.parse()
