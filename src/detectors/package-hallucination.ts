/**
 * AIDE - 包导入幻觉检测器
 * 检测 AI 生成代码中引用不存在的包/模块
 *
 * 从 @aide-dev/guard 的 HallucinationDetector.checkPackageImports() 迁移
 * 支持 12 种语言的包导入检查
 */

import * as fs from 'fs'
import * as path from 'path'
import { glob } from 'glob'
import { isTestFile } from '../types/index.js'
import { getLineNumber } from '../core/utils.js'
import type { Detector, DetectorContext, Issue, Language, Confidence } from '../types/index.js'
import type { CodeGraph } from '../core/code-graph.js'

/**
 * 带文件版本戳的缓存条目。
 * 解决原先缓存"永不失效"的设计隐患：在长期运行的进程（watch 模式、
 * 语言服务器、CI 多项目扫描）中，依赖清单被修改后缓存仍返回旧值，
 * 导致新加的包被误报为幻觉、被删除的包不再被检测。
 */
interface VersionedCacheEntry<T> {
  /** 缓存创建时所有相关清单文件的最大 mtimeMs（不存在文件视为 0） */
  version: number
  value: T
}

/** 计算给定清单文件列表的版本戳（取最大 mtimeMs） */
function manifestVersion(projectPath: string, files: string[]): number {
  let max = 0
  for (const f of files) {
    const p = path.join(projectPath, f)
    try {
      const stat = fs.statSync(p)
      if (stat.mtimeMs > max) max = stat.mtimeMs
    } catch {
      // 文件不存在，视为 0，不贡献版本
    }
  }
  return max
}

/** 读取带版本戳的缓存；版本不匹配时返回 undefined */
function getVersioned<T>(
  cache: Map<string, VersionedCacheEntry<T>>,
  projectPath: string,
  currentVersion: number,
): T | undefined {
  const entry = cache.get(projectPath)
  if (!entry || entry.version !== currentVersion) return undefined
  return entry.value
}

/** 写入带版本戳的缓存 */
function setVersioned<T>(
  cache: Map<string, VersionedCacheEntry<T>>,
  projectPath: string,
  currentVersion: number,
  value: T,
): void {
  cache.set(projectPath, { version: currentVersion, value })
}
import { PYTHON_STDLIB, PYTHON_COMMON_PACKAGES } from '../data/python-stdlib.js'
import { NODE_BUILTINS } from '../data/node-stdlib.js'
import { GO_STDLIB } from '../data/go-stdlib.js'
import {
  JAVA_STDLIB, RUST_STDLIB, RUBY_STDLIB, PHP_STDLIB,
  C_STDLIB, CPP_STDLIB, KOTLIN_STDLIB, SWIFT_STDLIB, CSHARP_STDLIB,
} from '../data/other-stdlibs.js'

/** 明显的占位符路径模式 — 这些不是真实 import，是测试数据或示例代码 */
const PLACEHOLDER_PATH_REGEX = /^(?:\.{3}|[xyz]{2,}|TODO|FIXME|placeholder|example|foobar?|dummy)$/i

export class PackageHallucinationDetector implements Detector {
  rule = 'package-hallucination'
  category = 'hallucination' as const
  description = '检测不存在的包/模块导入'
  severity = 'high' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, projectPath, filePath, codeGraph } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    switch (language) {
      case 'python': return this.checkPythonImports(source, projectPath, filePath, codeGraph)
      case 'typescript':
      case 'javascript': return this.checkJSImports(source, language, projectPath, filePath)
      case 'go': return this.checkGoImports(source, projectPath, filePath)
      case 'java': return this.checkJavaImports(source, projectPath, filePath)
      case 'rust': return this.checkRustImports(source, projectPath, filePath)
      case 'ruby': return this.checkRubyImports(source, projectPath, filePath)
      case 'php': return this.checkPHPImports(source, projectPath, filePath)
      case 'c': return this.checkCImports(source, projectPath, filePath)
      case 'cpp': return this.checkCppImports(source, projectPath, filePath)
      case 'kotlin': return this.checkKotlinImports(source, projectPath, filePath)
      case 'swift': return this.checkSwiftImports(source, projectPath, filePath)
      case 'csharp': return this.checkCSharpImports(source, projectPath, filePath)
      default: return []
    }
  }

  // ==================== 信任包检查 ====================

  private isTrustedPackage(packageName: string, language: Language): boolean {
    switch (language) {
      case 'python':
        if (PYTHON_STDLIB.has(packageName) || PYTHON_COMMON_PACKAGES.has(packageName)) return true
        break
      case 'typescript':
      case 'javascript':
        if (NODE_BUILTINS.has(packageName) || NODE_BUILTINS.has(`node:${packageName}`)) return true
        break
      case 'go':
        if (GO_STDLIB.has(packageName)) return true
        break
      case 'java':
        if (JAVA_STDLIB.has(packageName)) return true
        for (const stdlib of JAVA_STDLIB) {
          if (packageName.startsWith(stdlib + '.')) return true
        }
        break
      case 'rust':
        if (RUST_STDLIB.has(packageName)) return true
        for (const stdlib of RUST_STDLIB) {
          if (packageName.startsWith(stdlib + '::')) return true
        }
        break
      case 'ruby':
        if (RUBY_STDLIB.has(packageName)) return true
        break
      case 'php':
        if (PHP_STDLIB.has(packageName)) return true
        break
      case 'c':
        if (C_STDLIB.has(packageName)) return true
        break
      case 'cpp':
        if (CPP_STDLIB.has(packageName) || C_STDLIB.has(packageName)) return true
        break
      case 'kotlin':
        if (KOTLIN_STDLIB.has(packageName)) return true
        for (const stdlib of KOTLIN_STDLIB) {
          if (packageName.startsWith(stdlib + '.')) return true
        }
        break
      case 'swift':
        if (SWIFT_STDLIB.has(packageName)) return true
        break
      case 'csharp':
        if (CSHARP_STDLIB.has(packageName)) return true
        for (const stdlib of CSHARP_STDLIB) {
          if (packageName.startsWith(stdlib + '.')) return true
        }
        break
    }
    return false
  }

  // ==================== Python ====================

  private checkPythonImports(code: string, projectPath: string, filePath?: string, codeGraph?: CodeGraph): Issue[] {
    const issues: Issue[] = []
    const importRegex = /^(?:from\s+(\S+)\s+import\s+|\s*import\s+)(\S+)/gm
    let match

    while ((match = importRegex.exec(code)) !== null) {
      const rawModule = match[1] || match[2]
      const moduleName = rawModule.split('.')[0]

      // 跳过占位符模块名
      if (PLACEHOLDER_PATH_REGEX.test(rawModule)) continue

      // 跳过相对导入（from . import / from .. import）
      if (rawModule.startsWith('.')) continue
      if (!moduleName) continue
      const line = getLineNumber(code, match.index)

      if (this.isTrustedPackage(moduleName, 'python')) continue
      if (moduleName.startsWith('.')) continue
      if (this.isProjectModulePython(moduleName, projectPath, codeGraph)) continue
      if (this.isDeclaredPythonDependency(moduleName, projectPath)) continue
      if (this.isInstalledPythonPackage(moduleName, projectPath)) continue

      issues.push({
        rule: this.rule,
        severity: 'high',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的Python包: "${moduleName}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${moduleName}" 是否为真实存在的包。如果不存在，请删除此导入；如果存在但未安装，请运行: pip install ${moduleName}`,
        confidence: 'high' as Confidence,
        meta: { packageName: moduleName, language: 'python' },
      })
    }

    return issues
  }

  /** 缓存：项目 Python 模块名集合 */
  private pythonModulesCache = new Map<string, VersionedCacheEntry<Set<string>>>()

  private isProjectModulePython(moduleName: string, projectPath: string, codeGraph?: CodeGraph): boolean {
    // 代码图路径：使用构建好的模块索引（比 glob 扫描更精确，且无文件系统开销）
    if (codeGraph) {
      // 检查 moduleName 是否在代码图的 moduleToFiles 中
      if (codeGraph.moduleToFiles.has(moduleName)) return true
      // 也检查带下划线和横线的变体
      if (codeGraph.moduleToFiles.has(moduleName.replace(/-/g, '_'))) return true
      if (codeGraph.moduleToFiles.has(moduleName.replace(/_/g, '-'))) return true
      
      // 检查 moduleName 是否为某个已注册模块的"顶层包"
      // 例如 moduleName='contract_comparator', 已注册 'src.contract_comparator'
      // 则 import contract_comparator.config 应视为项目内部模块
      for (const [modName] of codeGraph.moduleToFiles) {
        if (modName === moduleName) return true
        // 检查 dotted path 的第一段是否匹配
        const dotIdx = modName.indexOf('.')
        if (dotIdx > 0) {
          const topSegment = modName.substring(0, dotIdx)
          if (topSegment === moduleName || topSegment === moduleName.replace(/-/g, '_')) {
            return true
          }
        }
      }
      
      // 检查 moduleName 是否为代码图中某个文件的定义（Python 模块通常与文件同名）
      for (const [, files] of codeGraph.files) {
        if (files.language === 'python' && files.definitions.includes(moduleName)) return true
      }
      return false
    }

    // 回退路径：glob 扫描（无代码图时使用）
    const version = manifestVersion(projectPath, ['.'])
    let modules = getVersioned(this.pythonModulesCache, projectPath, version)
    if (!modules) {
      modules = this.scanPythonModules(projectPath)
      setVersioned(this.pythonModulesCache, projectPath, version, modules)
    }
    return modules.has(moduleName) || modules.has(moduleName.replace(/-/g, '_')) || modules.has(moduleName.replace(/_/g, '-'))
  }

  /** 递归扫描项目目录下所有 .py 文件，收集模块名 */
  private scanPythonModules(projectPath: string): Set<string> {
    const modules = new Set<string>()
    try {
      const pyFiles = glob.sync('**/*.py', {
        cwd: projectPath,
        absolute: false,
        ignore: [
          '**/node_modules/**', '**/.git/**', '**/venv/**', '**/.venv/**',
          '**/__pycache__/**', '**/.tox/**', '**/.mypy_cache/**',
          '**/.pytest_cache/**', '**/dist/**', '**/build/**',
          '**/.egg*/**', '**/site-packages/**',
        ],
      })
      for (const f of pyFiles) {
        const dir = path.dirname(f)
        const basename = path.basename(f, '.py')
        // 非 __init__.py → 记录模块名
        if (basename !== '__init__') {
          modules.add(basename)
          // 同时记录带路径的模块名（如 utils.helpers）
          const dotted = dir === '.' ? basename : `${dir.replace(/[/\\]/g, '.')}.${basename}`
          modules.add(dotted)
        }
        // __init__.py → 将目录路径转成模块名
        if (basename === '__init__') {
          const parentDir = dir.replace(/[/\\]/g, '.')
          if (parentDir !== '.') modules.add(parentDir)
          
          // 支持 src layout：提取顶层包名
          // src/contract_comparator/__init__.py → 同时注册 contract_comparator
          const dirParts = parentDir.split('.')
          if (dirParts.length >= 2) {
            const firstPart = dirParts[0]
            if (firstPart === 'src' || firstPart === 'lib' || firstPart === 'source') {
              const topPackage = dirParts.slice(1).join('.')
              if (topPackage) modules.add(topPackage)
            }
          }
        }
      }
    } catch {
      // glob 失败时静默处理，fallback 到空集合
    }
    return modules
  }

  /** 检查包是否在 pyproject.toml / requirements.txt / setup.py 中声明 */
  private declaredDepsCache = new Map<string, VersionedCacheEntry<Set<string>>>()

  private isDeclaredPythonDependency(moduleName: string, projectPath: string): boolean {
    const version = manifestVersion(projectPath, [
      'requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt',
      'pyproject.toml', 'setup.py',
    ])
    let deps = getVersioned(this.declaredDepsCache, projectPath, version)
    if (!deps) {
      deps = this.parsePythonDependencies(projectPath)
      setVersioned(this.declaredDepsCache, projectPath, version, deps)
    }
    return deps.has(moduleName) || deps.has(moduleName.replace(/-/g, '_')) || deps.has(moduleName.replace(/_/g, '-'))
  }

  private parsePythonDependencies(projectPath: string): Set<string> {
    let deps = new Set<string>()

    // 解析 requirements.txt
    const reqFiles = ['requirements.txt', 'requirements-dev.txt', 'dev-requirements.txt']
    for (const reqFile of reqFiles) {
      const reqPath = path.join(projectPath, reqFile)
      if (fs.existsSync(reqPath)) {
        try {
          const content = fs.readFileSync(reqPath, 'utf-8')
          for (const line of content.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue
            // 提取包名（去掉版本号等）
            const pkgName = trimmed.split(/[=<>!~\s\[]/)[0]!
            if (pkgName) deps.add(pkgName.toLowerCase())
          }
        } catch { /* ignore */ }
      }
    }

    // 解析 pyproject.toml（支持 PEP 621、Poetry、PDM 格式）
    const pyprojectPath = path.join(projectPath, 'pyproject.toml')
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf-8')
        deps = this.parsePyprojectToml(content, deps)
      } catch { /* ignore */ }
    }

    // 解析 poetry.lock（Poetry 锁文件）
    const poetryLockPath = path.join(projectPath, 'poetry.lock')
    if (fs.existsSync(poetryLockPath)) {
      try {
        const content = fs.readFileSync(poetryLockPath, 'utf-8')
        deps = this.parsePoetryLock(content, deps)
      } catch { /* ignore */ }
    }

    // 解析 pdm.lock（PDM 锁文件）
    const pdmLockPath = path.join(projectPath, 'pdm.lock')
    if (fs.existsSync(pdmLockPath)) {
      try {
        const content = fs.readFileSync(pdmLockPath, 'utf-8')
        deps = this.parsePdmLock(content, deps)
      } catch { /* ignore */ }
    }

    // 解析 Pipfile（pipenv）
    const pipfilePath = path.join(projectPath, 'Pipfile')
    if (fs.existsSync(pipfilePath)) {
      try {
        const content = fs.readFileSync(pipfilePath, 'utf-8')
        deps = this.parsePipfile(content, deps)
      } catch { /* ignore */ }
    }

    // 解析 setup.py（简单正则）
    const setupPath = path.join(projectPath, 'setup.py')
    if (fs.existsSync(setupPath)) {
      try {
        const content = fs.readFileSync(setupPath, 'utf-8')
        const installRegex = /["']([a-zA-Z0-9_-]+)["']\s*[=<>!~]/g
        let match: RegExpExecArray | null
        while ((match = installRegex.exec(content)) !== null) {
          deps.add(match[1]!.toLowerCase())
        }
      } catch { /* ignore */ }
    }

    return deps
  }

  private isInstalledPythonPackage(moduleName: string, projectPath: string): boolean {
    const venvPaths = [
      path.join(projectPath, 'venv', 'lib'),
      path.join(projectPath, '.venv', 'lib'),
    ]
    for (const venvLib of venvPaths) {
      if (!fs.existsSync(venvLib)) continue
      try {
        const entries = fs.readdirSync(venvLib)
        for (const entry of entries) {
          if (entry.startsWith('python')) {
            const sitePackages = path.join(venvLib, entry, 'site-packages', moduleName)
            if (fs.existsSync(sitePackages)) return true
          }
        }
      } catch { /* ignore */ }
    }
    return false
  }

  // ==================== Python 依赖文件解析 ====================

  /** 解析 pyproject.toml（支持 PEP 621、Poetry、PDM 格式） */
  private parsePyprojectToml(content: string, deps: Set<string>): Set<string> {
    const lines = content.split('\n')
    let currentSection = ''

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim()

      // 检测当前 section
      const sectionMatch = line.match(/^\[([^\]]+)\]/)
      if (sectionMatch) {
        currentSection = sectionMatch[1]!
        continue
      }

      // 跳过注释和空行
      if (!line || line.startsWith('#')) continue

      // PEP 621 格式：[project.dependencies]
      if (currentSection === 'project.dependencies' || currentSection === 'project.optional-dependencies.*') {
        const pkgMatch = line.match(/^["']([a-zA-Z0-9_-]+)["']/)
        if (pkgMatch) {
          deps.add(pkgMatch[1]!.toLowerCase())
        }
        continue
      }

      // Poetry 格式：[tool.poetry.dependencies]、[tool.poetry.dev-dependencies]、[tool.poetry.group.*.dependencies]
      if (currentSection.startsWith('tool.poetry.') && currentSection.includes('dependencies')) {
        // Poetry 依赖格式：
        // pandas = "^1.5.0"
        // numpy = {version = "^1.23.0", optional = true}
        const poetryDepMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=/)
        if (poetryDepMatch) {
          const pkgName = poetryDepMatch[1]!.toLowerCase()
          // 跳过 python 特殊依赖
          if (pkgName !== 'python') {
            deps.add(pkgName)
          }
        }
        continue
      }

      // PDM 格式：[tool.pdm.dependencies]、[tool.pdm.dev-dependencies]
      if (currentSection.startsWith('tool.pdm.') && currentSection.includes('dependencies')) {
        // PDM 依赖格式：
        // "pandas>=1.5.0"
        // "pytest>=7.0"
        const pdmDepMatch = line.match(/^["']([a-zA-Z0-9_-]+)[^"']*["']/)
        if (pdmDepMatch) {
          deps.add(pdmDepMatch[1]!.toLowerCase())
        }
        continue
      }

      // 通用：匹配依赖声明（无 section 限制）
      const genericDepMatch = line.match(/^["']([a-zA-Z0-9_-]+)["']\s*[=<>!~\[]/)
      if (genericDepMatch) {
        deps.add(genericDepMatch[1]!.toLowerCase())
      }

      // 匹配裸包名（无版本号）
      const bareDepMatch = line.match(/^["']([a-zA-Z0-9_-]+)["']\s*[,]/)
      if (bareDepMatch) {
        deps.add(bareDepMatch[1]!.toLowerCase())
      }
    }

    return deps
  }

  /** 解析 poetry.lock（Poetry 锁文件） */
  private parsePoetryLock(content: string, deps: Set<string>): Set<string> {
    // poetry.lock 格式：
    // [[package]]
    // name = "pandas"
    // version = "1.5.3"
    const packageRegex = /^\[\[package\]\]\s*\n(?:.*\n)*?name\s*=\s*"([^"]+)"/gm
    let match: RegExpExecArray | null
    while ((match = packageRegex.exec(content)) !== null) {
      const pkgName = match[1]!.toLowerCase()
      // 跳过 python 自身
      if (pkgName !== 'python') {
        deps.add(pkgName)
      }
    }
    return deps
  }

  /** 解析 pdm.lock（PDM 锁文件） */
  private parsePdmLock(content: string, deps: Set<string>): Set<string> {
    // pdm.lock 格式：
    // [[package]]
    // name = "pandas"
    // version = "1.5.3"
    const packageRegex = /^\[\[package\]\]\s*\n(?:.*\n)*?name\s*=\s*"([^"]+)"/gm
    let match: RegExpExecArray | null
    while ((match = packageRegex.exec(content)) !== null) {
      const pkgName = match[1]!.toLowerCase()
      // 跳过 python 自身
      if (pkgName !== 'python') {
        deps.add(pkgName)
      }
    }
    return deps
  }

  /** 解析 Pipfile（pipenv） */
  private parsePipfile(content: string, deps: Set<string>): Set<string> {
    const lines = content.split('\n')
    let currentSection = ''

    for (const line of lines) {
      const trimmed = line.trim()

      // 检测 section
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]/)
      if (sectionMatch) {
        currentSection = sectionMatch[1]!
        continue
      }

      // 跳过注释和空行
      if (!trimmed || trimmed.startsWith('#')) continue

      // 解析 [packages] 和 [dev-packages] 中的依赖
      if (currentSection === 'packages' || currentSection === 'dev-packages') {
        // Pipfile 依赖格式：
        // pandas = ">=1.5.0"
        // numpy = "*"
        const depMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/)
        if (depMatch) {
          deps.add(depMatch[1]!.toLowerCase())
        }
      }
    }

    return deps
  }

  // ==================== JavaScript/TypeScript ====================

  private checkJSImports(code: string, language: Language, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const importRegex = /(?:import\s+.*?\s+from\s+|require\s*\(\s*)['"`]([^'"`\s]+)['"`]/g
    let match

    // 修复：相对路径应相对于源文件目录解析
    const fileDir = filePath ? path.dirname(path.join(projectPath, filePath)) : projectPath
    // 新增：monorepo 支持 — 从源文件位置向上查找最近的 package.json
    const nearestPkgDir = this.findNearestPackageJson(filePath, projectPath)

    while ((match = importRegex.exec(code)) !== null) {
      const modulePath = match[1]
      const line = getLineNumber(code, match.index)

      // 跳过占位符路径（"xxx", "...", "TODO" 等）
      if (PLACEHOLDER_PATH_REGEX.test(modulePath)) continue

      if (this.isTrustedPackage(modulePath, language)) continue

      // 相对路径导入 — 跳过，由 TypeScript 编译器 / 构建工具负责
      // aide 的相对路径解析在 ESM monorepo 等场景下误报率高，不具备可靠检测能力
      if (modulePath.startsWith('.') || modulePath.startsWith('/')) {
        continue
      }

      // npm 包 — 优先检查最近 package.json，再检查根目录
      const packageName = this.extractNpmPackageName(modulePath)
      if (nearestPkgDir && this.isDeclaredNpmDependencyInPackage(packageName, nearestPkgDir)) continue
      if (this.isDeclaredNpmDependency(packageName, projectPath)) continue
      if (nearestPkgDir && this.isInstalledNpmPackage(packageName, nearestPkgDir)) continue
      if (this.isInstalledNpmPackage(packageName, projectPath)) continue

      issues.push({
        rule: this.rule,
        severity: 'high',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的npm包: "${packageName}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${packageName}" 是否为真实存在的包。如果不存在，请删除此导入；如果存在但未安装，请运行: npm install ${packageName}`,
        confidence: 'high' as Confidence,
        meta: { packageName, language: language === 'typescript' ? 'typescript' : 'javascript' },
      })
    }

    return issues
  }

  /** 从文件路径向上查找最近的 package.json 所在目录 */
  private findNearestPackageJson(filePath: string | undefined, projectPath: string): string | null {
    if (!filePath) return fs.existsSync(path.join(projectPath, 'package.json')) ? projectPath : null

    let dir = path.dirname(path.join(projectPath, filePath))
    while (dir.startsWith(projectPath) || dir === projectPath) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    // 最后尝试 projectPath 本身
    return fs.existsSync(path.join(projectPath, 'package.json')) ? projectPath : null
  }

  /** 检查包是否在指定目录的 package.json 中声明（带缓存） */
  private isDeclaredNpmDependencyInPackage(packageName: string, pkgDir: string): boolean {
    const version = manifestVersion(pkgDir, ['package.json'])
    let deps = getVersioned(this.npmDepsCache, pkgDir, version)
    if (!deps) {
      deps = this.parseNpmDependencies(pkgDir)
      setVersioned(this.npmDepsCache, pkgDir, version, deps)
    }
    return deps.has(packageName)
  }

  private extractNpmPackageName(modulePath: string): string {
    if (modulePath.startsWith('@')) {
      const parts = modulePath.split('/')
      return parts.length >= 2 ? parts[0] + '/' + parts[1] : parts[0]
    }
    return modulePath.split('/')[0]
  }

  /** 检查包是否在 package.json 的 dependencies/devDependencies 中声明 */
  private npmDepsCache = new Map<string, VersionedCacheEntry<Set<string>>>()

  private isDeclaredNpmDependency(packageName: string, projectPath: string): boolean {
    const version = manifestVersion(projectPath, ['package.json'])
    let deps = getVersioned(this.npmDepsCache, projectPath, version)
    if (!deps) {
      deps = this.parseNpmDependencies(projectPath)
      setVersioned(this.npmDepsCache, projectPath, version, deps)
    }
    return deps.has(packageName)
  }

  private parseNpmDependencies(projectPath: string): Set<string> {
    const deps = new Set<string>()
    const pkgJsonPath = path.join(projectPath, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) return deps
    try {
      const content = fs.readFileSync(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(content)
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const section = pkg[key]
        if (section && typeof section === 'object') {
          for (const name of Object.keys(section)) {
            deps.add(name)
          }
        }
      }
    } catch { /* ignore */ }
    return deps
  }

  private isInstalledNpmPackage(packageName: string, projectPath: string): boolean {
    const pkgDir = path.join(projectPath, 'node_modules', packageName)
    return fs.existsSync(pkgDir)
  }

  private resolveJSRelativePath(modulePath: string, fileDir: string, projectPath: string): boolean {
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']
    // TypeScript 项目中 import from './types.js' 是合法的，实际对应 ./types.ts
    // 先尝试去掉 .js/.mjs/.cjs 后缀，再尝试原始路径
    const pathWithoutJsExt = modulePath.replace(/\.(mjs|cjs|js)$/, '')
    const candidates = [modulePath, pathWithoutJsExt]
    const resolved = path.resolve(fileDir, modulePath)

    // 路径边界检查
    if (!resolved.startsWith(projectPath)) return false

    for (const candidate of candidates) {
      const resolvedPath = path.resolve(fileDir, candidate)
      if (!resolvedPath.startsWith(projectPath)) continue
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) return true
      for (const ext of extensions) {
        if (fs.existsSync(resolvedPath + ext)) return true
      }
    }
    return false
  }

  // ==================== Go ====================

  private checkGoImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const importBlockRegex = /import\s*\(([\s\S]*?)\)/g
    const singleImportRegex = /import\s+"([^"]+)"/g
    let match

    const goModInfo = this.parseGoMod(projectPath)

    while ((match = importBlockRegex.exec(code)) !== null) {
      const blockContent = match[1]
      const pkgRegex = /"([^"]+)"/g
      let pkgMatch
      while ((pkgMatch = pkgRegex.exec(blockContent)) !== null) {
        this.checkSingleGoImport(pkgMatch[1], code, match.index + pkgMatch.index, projectPath, goModInfo, issues, filePath)
      }
    }

    while ((match = singleImportRegex.exec(code)) !== null) {
      this.checkSingleGoImport(match[1], code, match.index, projectPath, goModInfo, issues, filePath)
    }

    return issues
  }

  private checkSingleGoImport(
    importPath: string, code: string, index: number,
    projectPath: string, goModInfo: { moduleName: string; dependencies: Set<string> } | null,
    issues: Issue[], filePath?: string,
  ): void {
    const line = getLineNumber(code, index)
    if (this.isTrustedPackage(importPath, 'go')) return
    if (goModInfo && importPath.startsWith(goModInfo.moduleName)) return
    if (goModInfo && goModInfo.dependencies.has(importPath)) return

    const vendorPath = path.join(projectPath, 'vendor', importPath)
    if (fs.existsSync(vendorPath)) return

    issues.push({
      rule: this.rule,
      severity: 'high',
      category: 'hallucination',
      file: filePath || '',
      line,
      message: `可能不存在的Go包: "${importPath}"`,
      snippet: `import "${importPath}"`,
      suggestion: `请确认 "${importPath}" 是否在 go.mod 中声明，可运行: go get ${importPath}`,
      confidence: 'high' as Confidence,
      meta: { packageName: importPath, language: 'go' },
    })
  }

  private parseGoMod(projectPath: string): { moduleName: string; dependencies: Set<string> } | null {
    const goModPath = path.join(projectPath, 'go.mod')
    if (!fs.existsSync(goModPath)) return null
    try {
      const content = fs.readFileSync(goModPath, 'utf-8')
      const moduleMatch = content.match(/^module\s+(\S+)/m)
      const moduleName = moduleMatch ? moduleMatch[1] : ''
      const dependencies = new Set<string>()
      const requireRegex = /^\s*(\S+)\s+v[\d.]+/gm
      let reqMatch
      while ((reqMatch = requireRegex.exec(content)) !== null) {
        dependencies.add(reqMatch[1])
      }
      return { moduleName, dependencies }
    } catch {
      return null
    }
  }

  // ==================== Java ====================

  private checkJavaImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const importRegex = /^import\s+(?:static\s+)?([^;]+);/gm
    let match

    while ((match = importRegex.exec(code)) !== null) {
      const importPath = match[1].trim()
      const line = getLineNumber(code, match.index)
      const rootPackage = importPath.split('.')[0]

      if (this.isTrustedPackage(rootPackage, 'java')) continue
      if (this.isTrustedPackage(importPath, 'java')) continue

      // 检查项目源码目录
      const javaPath = importPath.replace(/\./g, '/') + '.java'
      const srcMain = path.join(projectPath, 'src', 'main', 'java', javaPath)
      if (fs.existsSync(srcMain)) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的Java包: "${importPath}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${importPath}" 是否为真实存在的包`,
        confidence: 'high' as Confidence,
        meta: { packageName: importPath, language: 'java' },
      })
    }

    return issues
  }

  // ==================== Rust ====================

  private checkRustImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const useRegex = /^use\s+([^;]+);/gm
    let match

    while ((match = useRegex.exec(code)) !== null) {
      const usePath = match[1].trim()
      const line = getLineNumber(code, match.index)
      const rootCrate = usePath.split('::')[0]

      if (this.isTrustedPackage(rootCrate, 'rust')) continue

      // 检查 Cargo.toml 依赖
      if (this.isRustDependency(rootCrate, projectPath)) continue

      // 检查项目模块
      const modFile = path.join(projectPath, 'src', rootCrate + '.rs')
      const modDir = path.join(projectPath, 'src', rootCrate, 'mod.rs')
      if (fs.existsSync(modFile) || fs.existsSync(modDir)) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的Rust crate: "${rootCrate}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${rootCrate}" 是否在 Cargo.toml 中声明`,
        confidence: 'high' as Confidence,
        meta: { packageName: rootCrate, language: 'rust' },
      })
    }

    return issues
  }

  private isRustDependency(crateName: string, projectPath: string): boolean {
    const cargoPath = path.join(projectPath, 'Cargo.toml')
    if (!fs.existsSync(cargoPath)) return false
    try {
      const content = fs.readFileSync(cargoPath, 'utf-8')
      return content.includes(crateName)
    } catch {
      return false
    }
  }

  // ==================== Ruby ====================

  private checkRubyImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const requireRegex = /require\s+['"]([^'"]+)['"]/g
    let match

    while ((match = requireRegex.exec(code)) !== null) {
      const moduleName = match[1]
      const line = getLineNumber(code, match.index)

      if (this.isTrustedPackage(moduleName, 'ruby')) continue
      if (moduleName.startsWith('.')) continue

      // 检查 Gemfile
      if (this.isRubyGem(moduleName, projectPath)) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的Ruby gem: "${moduleName}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${moduleName}" 是否为真实存在的 gem`,
        confidence: 'high' as Confidence,
        meta: { packageName: moduleName, language: 'ruby' },
      })
    }

    return issues
  }

  private isRubyGem(gemName: string, projectPath: string): boolean {
    const gemfilePath = path.join(projectPath, 'Gemfile')
    if (!fs.existsSync(gemfilePath)) return false
    try {
      const content = fs.readFileSync(gemfilePath, 'utf-8')
      return content.includes(gemName)
    } catch {
      return false
    }
  }

  // ==================== PHP ====================

  private checkPHPImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const useRegex = /^use\s+([^;]+);/gm
    const requireRegex = /(?:require|include)(?:_once)?\s+['"]([^'"]+)['"]/g
    let match

    while ((match = useRegex.exec(code)) !== null) {
      const namespace = match[1].trim()
      const line = getLineNumber(code, match.index)
      const rootNs = namespace.split('\\')[0]

      if (this.isTrustedPackage(rootNs, 'php')) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的PHP命名空间: "${namespace}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${namespace}" 是否为真实存在的包`,
        confidence: 'high' as Confidence,
        meta: { packageName: namespace, language: 'php' },
      })
    }

    while ((match = requireRegex.exec(code)) !== null) {
      const requirePath = match[1]
      const line = getLineNumber(code, match.index)

      if (!requirePath.startsWith('.') && !requirePath.startsWith('/')) continue

      const resolved = path.resolve(path.dirname(path.join(projectPath, filePath || '')), requirePath)
      if (fs.existsSync(resolved)) continue

      issues.push({
        rule: this.rule,
        severity: 'high',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `相对路径引用不存在: "${requirePath}"`,
        snippet: match[0].trim(),
        suggestion: `请确认文件路径 "${requirePath}" 是否正确`,
        confidence: 'high' as Confidence,
        meta: { packageName: requirePath, language: 'php', importType: 'relative' },
      })
    }

    return issues
  }

  // ==================== C ====================

  private checkCImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const includeRegex = /#include\s+<([^>]+)>/g
    let match

    while ((match = includeRegex.exec(code)) !== null) {
      const headerName = match[1]
      const line = getLineNumber(code, match.index)

      if (this.isTrustedPackage(headerName, 'c')) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的C头文件: "${headerName}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${headerName}" 是否为真实存在的头文件`,
        confidence: 'high' as Confidence,
        meta: { packageName: headerName, language: 'c' },
      })
    }

    return issues
  }

  // ==================== C++ ====================

  private checkCppImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const includeRegex = /#include\s+<([^>]+)>/g
    let match

    while ((match = includeRegex.exec(code)) !== null) {
      const headerName = match[1]
      const line = getLineNumber(code, match.index)

      if (this.isTrustedPackage(headerName, 'cpp')) continue
      if (this.isTrustedPackage(headerName, 'c')) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的C++头文件: "${headerName}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${headerName}" 是否为真实存在的头文件`,
        confidence: 'high' as Confidence,
        meta: { packageName: headerName, language: 'cpp' },
      })
    }

    return issues
  }

  // ==================== Kotlin ====================

  private checkKotlinImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const importRegex = /^import\s+([^;]+)$/gm
    let match

    while ((match = importRegex.exec(code)) !== null) {
      const importPath = match[1].trim()
      const line = getLineNumber(code, match.index)
      const rootPackage = importPath.split('.')[0]

      if (this.isTrustedPackage(rootPackage, 'kotlin')) continue
      if (this.isTrustedPackage(importPath, 'kotlin')) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的Kotlin包: "${importPath}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${importPath}" 是否为真实存在的包`,
        confidence: 'high' as Confidence,
        meta: { packageName: importPath, language: 'kotlin' },
      })
    }

    return issues
  }

  // ==================== Swift ====================

  private checkSwiftImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const importRegex = /^import\s+(\S+)/gm
    let match

    while ((match = importRegex.exec(code)) !== null) {
      const moduleName = match[1]
      const line = getLineNumber(code, match.index)

      if (this.isTrustedPackage(moduleName, 'swift')) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的Swift模块: "${moduleName}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${moduleName}" 是否为真实存在的框架或模块`,
        confidence: 'high' as Confidence,
        meta: { packageName: moduleName, language: 'swift' },
      })
    }

    return issues
  }

  // ==================== C# ====================

  private checkCSharpImports(code: string, projectPath: string, filePath?: string): Issue[] {
    const issues: Issue[] = []
    const usingRegex = /^using\s+(?:static\s+)?([^;=]+);/gm
    let match

    while ((match = usingRegex.exec(code)) !== null) {
      const namespace = match[1].trim()
      const line = getLineNumber(code, match.index)
      const rootNs = namespace.split('.')[0]

      if (this.isTrustedPackage(rootNs, 'csharp')) continue
      if (this.isTrustedPackage(namespace, 'csharp')) continue

      issues.push({
        rule: this.rule,
        severity: 'medium',
        category: 'hallucination',
        file: filePath || '',
        line,
        message: `可能不存在的C#命名空间: "${namespace}"`,
        snippet: match[0].trim(),
        suggestion: `请确认 "${namespace}" 是否为真实存在的命名空间`,
        confidence: 'high' as Confidence,
        meta: { packageName: namespace, language: 'csharp' },
      })
    }

    return issues
  }
}
