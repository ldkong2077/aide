/**
 * AIDE - 项目结构检查检测器
 * 检测缺失的配置文件、不一致的依赖声明、入口文件不存在等
 */

import * as fs from 'fs'
import * as path from 'path'
import { glob } from 'glob'
import type { Detector, DetectorContext, Issue } from '../types/index.js'

/** 结构检查忽略的目录（与 scanner.ts DEFAULT_IGNORE 保持一致） */
const STRUCTURE_IGNORE = [
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '.codegraph', '.aide', 'target',
  'vendor', 'pods', 'carthage', '__pycache__', '.venv', 'venv',
  '.tox', '.mypy_cache', '.pytest_cache', '_archive',
]

export class StructureDetector implements Detector {
  rule = 'structure'
  category = 'correctness' as const
  description = '检测项目结构问题、缺失配置文件、依赖不一致'
  severity = 'medium' as const

  // 结构检查只需对项目根目录执行一次，用缓存避免重复
  private checkedProjects = new Set<string>()

  detect(ctx: DetectorContext): Issue[] {
    const { projectPath, filePath } = ctx
    const issues: Issue[] = []

    // 只对项目根目录的第一个文件执行结构检查
    // 避免每个文件都重复检查
    if (this.checkedProjects.has(projectPath)) return issues
    this.checkedProjects.add(projectPath)

    // 只检查项目实际使用的语言相关的配置
    // 避免对多语言项目误报（如 TS 项目报 Go/Rust 缺少配置）
    this.checkMissingConfigFiles(projectPath, filePath, issues)
    this.checkEntryFiles(projectPath, filePath, issues)
    this.checkDependencyConsistency(projectPath, filePath, issues)

    return issues
  }

  /** 检测缺失的配置文件 */
  private checkMissingConfigFiles(projectPath: string, filePath: string, issues: Issue[]): void {
    const hasPackageJson = fs.existsSync(path.join(projectPath, 'package.json'))
    const hasTsFiles = this.hasFilesWithExt(projectPath, '.ts')
    const hasPyFiles = this.hasFilesWithExt(projectPath, '.py')
    const hasGoFiles = this.hasFilesWithExt(projectPath, '.go')
    const hasRsFiles = this.hasFilesWithExt(projectPath, '.rs')

    // 只有项目根目录有 package.json 或 ts 文件才检查 TS 相关配置
    // TypeScript 项目缺少 tsconfig.json
    if (hasPackageJson && hasTsFiles && !fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'correctness',
        file: filePath,
        line: 1,
        message: 'TypeScript 项目缺少 tsconfig.json',
        suggestion: '运行 tsc --init 创建 tsconfig.json',
      })
    }

    // package.json 中使用了 import 但未设置 type: module
    if (hasPackageJson) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'))
        if (pkg.type !== 'module') {
          // 检查是否有 .js 文件使用了 import 语法
          if (this.hasESMImports(projectPath)) {
            issues.push({
              rule: this.rule,
              severity: 'medium',
              category: 'correctness',
              file: filePath,
              line: 1,
              message: 'package.json 中 "type" 未设置为 "module"，但代码使用了 import 语法',
              suggestion: '在 package.json 中添加 "type": "module"',
            })
          }
        }
      } catch { /* ignore */ }
    }

    // Python 项目缺少 requirements.txt / pyproject.toml
    if (hasPyFiles) {
      const hasRequirements = fs.existsSync(path.join(projectPath, 'requirements.txt'))
      const hasPyproject = fs.existsSync(path.join(projectPath, 'pyproject.toml'))
      const hasSetupPy = fs.existsSync(path.join(projectPath, 'setup.py'))
      if (!hasRequirements && !hasPyproject && !hasSetupPy) {
        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'correctness',
          file: filePath,
          line: 1,
          message: 'Python 项目缺少依赖声明文件（requirements.txt / pyproject.toml / setup.py）',
          suggestion: '创建 requirements.txt 或 pyproject.toml 声明项目依赖',
        })
      }
    }

    // Go 项目缺少 go.mod — 只有项目有 go 文件且没有 package.json 时才检查
    // 避免对包含 go 测试数据的 TS 项目误报
    if (hasGoFiles && !hasPackageJson && !fs.existsSync(path.join(projectPath, 'go.mod'))) {
      issues.push({
        rule: this.rule,
        severity: 'high',
        category: 'correctness',
        file: filePath,
        line: 1,
        message: 'Go 项目缺少 go.mod',
        suggestion: '运行 go mod init 创建 go.mod',
      })
    }

    // Rust 项目缺少 Cargo.toml — 同理
    if (hasRsFiles && !hasPackageJson && !fs.existsSync(path.join(projectPath, 'Cargo.toml'))) {
      issues.push({
        rule: this.rule,
        severity: 'high',
        category: 'correctness',
        file: filePath,
        line: 1,
        message: 'Rust 项目缺少 Cargo.toml',
        suggestion: '运行 cargo init 创建 Cargo.toml',
      })
    }

    // 缺少 .gitignore
    if (!fs.existsSync(path.join(projectPath, '.gitignore'))) {
      issues.push({
        rule: this.rule,
        severity: 'low',
        category: 'correctness',
        file: filePath,
        line: 1,
        message: '项目缺少 .gitignore',
        suggestion: '创建 .gitignore 文件，排除 node_modules/dist/.env 等',
      })
    }
  }

  /** 检测入口文件是否存在 */
  private checkEntryFiles(projectPath: string, filePath: string, issues: Issue[]): void {
    const pkgPath = path.join(projectPath, 'package.json')
    if (!fs.existsSync(pkgPath)) return

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))

      // 检查 main 字段
      if (pkg.main && !fs.existsSync(path.join(projectPath, pkg.main))) {
        issues.push({
          rule: this.rule,
          severity: 'high',
          category: 'correctness',
          file: filePath,
          line: 1,
          message: `package.json 声明 "main": "${pkg.main}" 但该文件不存在`,
          suggestion: `创建 ${pkg.main} 或更新 package.json 中的 main 字段`,
        })
      }

      // 检查 module 字段
      if (pkg.module && !fs.existsSync(path.join(projectPath, pkg.module))) {
        issues.push({
          rule: this.rule,
          severity: 'medium',
          category: 'correctness',
          file: filePath,
          line: 1,
          message: `package.json 声明 "module": "${pkg.module}" 但该文件不存在`,
          suggestion: `创建 ${pkg.module} 或更新 package.json 中的 module 字段`,
        })
      }

      // 检查 bin 字段
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin) as string[]
        for (const binPath of bins) {
          if (!fs.existsSync(path.join(projectPath, binPath))) {
            issues.push({
              rule: this.rule,
              severity: 'high',
              category: 'correctness',
              file: filePath,
              line: 1,
              message: `package.json 声明 "bin": "${binPath}" 但该文件不存在`,
              suggestion: `创建 ${binPath} 或更新 package.json 中的 bin 字段`,
            })
          }
        }
      }
    } catch { /* ignore */ }
  }

  /** 检测依赖一致性 */
  private checkDependencyConsistency(projectPath: string, filePath: string, issues: Issue[]): void {
    const pkgPath = path.join(projectPath, 'package.json')
    if (!fs.existsSync(pkgPath)) return

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      const nodeModulesPath = path.join(projectPath, 'node_modules')

      // 如果没有 node_modules 目录，跳过检查
      if (!fs.existsSync(nodeModulesPath)) return

      for (const depName of Object.keys(deps)) {
        const depPath = path.join(nodeModulesPath, depName)
        if (!fs.existsSync(depPath)) {
          issues.push({
            rule: this.rule,
            severity: 'medium',
            category: 'correctness',
            file: filePath,
            line: 1,
            message: `依赖 "${depName}" 在 package.json 中声明但未安装`,
            suggestion: `运行 npm install ${depName} 安装缺失的依赖`,
          })
        }
      }
    } catch { /* ignore */ }
  }

  /** 检查项目中是否有指定扩展名的文件（使用 glob，尊重 ignore 列表） */
  private hasFilesWithExt(projectPath: string, ext: string): boolean {
    try {
      const ignorePatterns = STRUCTURE_IGNORE.map(d => `**/${d}/**`)
      const files = glob.sync(`**/*${ext}`, {
        cwd: projectPath,
        ignore: ignorePatterns,
        nodir: true,
        // 只需知道是否存在，找到第一个就停止
        // 限制最大深度避免在大项目中过慢
      })
      return files.length > 0
    } catch {
      return false
    }
  }

  /** 检查项目中是否有 ESM import 语法（使用 glob，尊重 ignore 列表） */
  private hasESMImports(projectPath: string): boolean {
    try {
      const srcDir = path.join(projectPath, 'src')
      if (!fs.existsSync(srcDir)) return false
      const ignorePatterns = STRUCTURE_IGNORE.map(d => `**/${d}/**`)
      const files = glob.sync('**/*.js', {
        cwd: srcDir,
        ignore: ignorePatterns,
        nodir: true,
      })
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(srcDir, file), 'utf-8')
          if (/import\s+.*?\s+from\s+['"]/.test(content)) return true
        } catch { continue }
      }
      return false
    } catch {
      return false
    }
  }
}
