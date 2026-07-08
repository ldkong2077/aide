/**
 * AIDE - 在线包注册表查询客户端
 * 查询 npm / PyPI / crates.io / Go Proxy / RubyGems 验证包是否存在
 *
 * 设计原则：
 * - 超时/网络错误 → 返回 null（降级到本地判断，不产生误报）
 * - 结果缓存 → 同一包名不重复查询
 * - 磁盘缓存 → 首次查询后持久化到 .aide/registry-cache.json，TTL 7 天
 * - 零外部依赖 → 使用 Node 18+ 内置 fetch
 */

import type { Language } from '../types/index.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'

/** 注册表查询结果 */
export interface RegistryResult {
  /** 包是否存在 */
  exists: boolean
  /** 查询的注册表 */
  source: RegistrySource
  /** 缓存时间戳（ms） */
  cachedAt?: number
}

export type RegistrySource = 'npm' | 'pypi' | 'crates' | 'goproxy' | 'rubygems'

/** 磁盘缓存 TTL：7 天 */
const DISK_CACHE_TTL = 7 * 24 * 60 * 60 * 1000

export class RegistryClient {
  private cache = new Map<string, RegistryResult | null>()
  private timeout: number
  private diskCachePath: string | null
  private diskCacheDirty = false
  private diskCache: Record<string, { exists: boolean; source: RegistrySource; cachedAt: number }> = {}

  constructor(options?: { timeout?: number; projectPath?: string }) {
    this.timeout = options?.timeout ?? 5000
    // 磁盘缓存路径：<project>/.aide/registry-cache.json
    if (options?.projectPath) {
      this.diskCachePath = join(options.projectPath, '.aide', 'registry-cache.json')
      this.loadDiskCache()
    } else {
      this.diskCachePath = null
    }
  }

  /**
   * 查询包是否在在线注册表中存在。
   * 返回 null 表示无法验证（网络错误/超时/不支持的语言）。
   */
  async check(packageName: string, language: Language): Promise<RegistryResult | null> {
    const key = `${language}:${packageName}`

    // 1. 内存缓存
    const memCached = this.cache.get(key)
    if (memCached !== undefined) return memCached

    // 2. 磁盘缓存
    const diskEntry = this.diskCache[key]
    if (diskEntry && diskEntry.cachedAt && Date.now() - diskEntry.cachedAt < DISK_CACHE_TTL) {
      const result: RegistryResult = { exists: diskEntry.exists, source: diskEntry.source, cachedAt: diskEntry.cachedAt }
      this.cache.set(key, result)
      return result
    }

    // 3. 在线查询
    const result = await this.queryRegistry(packageName, language)
    this.cache.set(key, result)

    // 4. 写入磁盘缓存
    if (result && this.diskCachePath) {
      this.diskCache[key] = { exists: result.exists, source: result.source, cachedAt: Date.now() }
      this.diskCacheDirty = true
    }

    return result
  }

  /** 批量查询，返回确认存在的包名集合 */
  async batchCheck(
    packages: Array<{ name: string; language: Language }>,
  ): Promise<Set<string>> {
    const confirmed = new Set<string>()
    const promises = packages.map(async ({ name, language }) => {
      const result = await this.check(name, language)
      if (result?.exists) {
        confirmed.add(`${language}:${name}`)
      }
    })
    await Promise.all(promises)

    // 批量查询后一次性写入磁盘
    this.flushDiskCache()

    return confirmed
  }

  /** 清除缓存 */
  clearCache(): void {
    this.cache.clear()
    this.diskCache = {}
    this.diskCacheDirty = false
  }

  /** 将脏数据写入磁盘缓存 */
  flushDiskCache(): void {
    if (!this.diskCacheDirty || !this.diskCachePath) return
    try {
      const dir = dirname(this.diskCachePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.diskCachePath, JSON.stringify(this.diskCache, null, 2), 'utf-8')
      this.diskCacheDirty = false
    } catch {
      // 磁盘写入失败不影响功能
    }
  }

  /** 加载磁盘缓存 */
  private loadDiskCache(): void {
    if (!this.diskCachePath) return
    try {
      if (!existsSync(this.diskCachePath)) return
      const data = readFileSync(this.diskCachePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (typeof parsed === 'object' && parsed !== null) {
        this.diskCache = parsed as typeof this.diskCache
        // 清除过期条目
        const now = Date.now()
        for (const [key, entry] of Object.entries(this.diskCache)) {
          if (entry.cachedAt && now - entry.cachedAt >= DISK_CACHE_TTL) {
            delete this.diskCache[key]
          }
        }
      }
    } catch {
      // 缓存文件损坏则忽略
    }
  }

  private async queryRegistry(
    packageName: string,
    language: Language,
  ): Promise<RegistryResult | null> {
    switch (language) {
      case 'python':
        return this.checkPyPI(packageName)
      case 'typescript':
      case 'javascript':
        return this.checkNpm(packageName)
      case 'rust':
        return this.checkCrates(packageName)
      case 'go':
        return this.checkGoProxy(packageName)
      case 'ruby':
        return this.checkRubyGems(packageName)
      default:
        return null
    }
  }

  // ==================== npm ====================

  private async checkNpm(name: string): Promise<RegistryResult | null> {
    try {
      const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeout),
        headers: { Accept: 'application/json' },
      })
      if (res.ok) return { exists: true, source: 'npm' }
      if (res.status === 404) return { exists: false, source: 'npm' }
      return null
    } catch {
      return null
    }
  }

  // ==================== PyPI ====================

  private async checkPyPI(name: string): Promise<RegistryResult | null> {
    try {
      const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeout),
        headers: { Accept: 'application/json' },
      })
      if (res.ok) return { exists: true, source: 'pypi' }
      if (res.status === 404) return { exists: false, source: 'pypi' }
      return null
    } catch {
      return null
    }
  }

  // ==================== crates.io ====================

  private async checkCrates(name: string): Promise<RegistryResult | null> {
    try {
      const url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeout),
        headers: {
          Accept: 'application/json',
          // crates.io 要求 User-Agent
          'User-Agent': 'AIDE-RegistryClient/1.0',
        },
      })
      if (res.ok) return { exists: true, source: 'crates' }
      if (res.status === 404) return { exists: false, source: 'crates' }
      return null
    } catch {
      return null
    }
  }

  // ==================== Go Proxy ====================

  private async checkGoProxy(pkgPath: string): Promise<RegistryResult | null> {
    try {
      // Go module proxy: GET $GOPROXY/<module>/@v/list
      // 使用 proxy.golang.org
      // Go module path 编码：大写字母 → !小写，! → !!
      const encoded = pkgPath.replace(/!/g, '!!').replace(/[A-Z]/g, c => '!' + c.toLowerCase())
      const url = `https://proxy.golang.org/${encoded}/@v/list`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeout),
      })
      if (res.ok) return { exists: true, source: 'goproxy' }
      if (res.status === 404 || res.status === 410) return { exists: false, source: 'goproxy' }
      return null
    } catch {
      return null
    }
  }

  // ==================== RubyGems ====================

  private async checkRubyGems(name: string): Promise<RegistryResult | null> {
    try {
      const url = `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeout),
        headers: { Accept: 'application/json' },
      })
      if (res.ok) return { exists: true, source: 'rubygems' }
      if (res.status === 404) return { exists: false, source: 'rubygems' }
      return null
    } catch {
      return null
    }
  }
}
