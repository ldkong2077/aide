/**
 * aide configure-llm model — 交互式配置 LLM 模型
 * aide configure-llm list — 列出已配置的模型
 */

import { Command } from 'commander'
import { configureModelInteractive, listModelsInteractive } from '../../core/llm-config.js'

export function configureLlmCommand(): Command {
  const cmd = new Command('configure-llm')
  cmd.description('配置 LLM 大模型（用于 scan-llm 命令，支持本地模型）')

  // configure-llm model
  cmd
    .command('model')
    .description('添加或编辑一个 LLM 模型配置')
    .action(async () => {
      await configureModelInteractive()
    })

  // configure-llm list
  cmd
    .command('list')
    .description('列出所有已配置的 LLM 模型')
    .action(() => {
      listModelsInteractive()
    })

  return cmd
}

/** @deprecated 保留旧命令兼容，后续版本移除 */
export function configureCommand(): Command {
  return configureLlmCommand().name('configure')
}
