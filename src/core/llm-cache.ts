/**
 * AIDE - LLM 缓存模块
 * 两级缓存：内存 LRU + 磁盘持久化
 */

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import type { CacheEntry, CacheStats } from './llm-types.js'

/** 默认内存缓存最大条目数 */
const DEFAULT_MEMORY_MAX_SIZE = 1000
/** 默认磁盘缓存目录 */
const DEFAULT_DISK_CACHE_DIR = '.aide/llm-cache'
/** 默认磁盘缓存 TTL（毫秒）= 24 小时 */
const DEFAULT_DISK_TTL_MS = 24 * 60 * 60 * 1000

/** 计算字符串的 SHA-256 hash（取前 16 字符） */
function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** 规范化 key：去除多余空白 */
function normalizeKey(key: string): string {
  return key.replace(/\s+/g, ' ').trim()
}

export class LlmCache {
  private memoryCache = new Map<string, CacheEntry>()
  private memoryHits = 0
  private memoryMisses = 0
  private diskHits = 0
  private diskDir: string
  private diskTtlMs: number
  private memoryMaxSize: number

  constructor(options?: {
    diskDir?: string
    diskTtlMs?: number
    memoryMaxSize?: number
  }) {
    this.diskDir = path.resolve(options?.diskDir || DEFAULT_DISK_CACHE_DIR)
    this.diskTtlMs = options?.diskTtlMs || DEFAULT_DISK_TTL_MS
    this.memoryMaxSize = options?.memoryMaxSize || DEFAULT_MEMORY_MAX_SIZE
  }

  /** 获取缓存条目（先查内存，再查磁盘） */
  async get(key: string): Promise<CacheEntry | null> {
    const nk = normalizeKey(key)

    // Level 1: 内存缓存
    const memEntry = this.memoryCache.get(nk)
    if (memEntry) {
      this.memoryHits++
      return memEntry
    }
    this.memoryMisses++

    // Level 2: 磁盘缓存
    try {
      const diskPath = path.join(this.diskDir, nk + '.json')
      const content = await fs.promises.readFile(diskPath, 'utf-8')
      const entry: CacheEntry = JSON.parse(content)

      // 检查 TTL
      if (Date.now() - entry.timestamp > this.diskTtlMs) {
        return null
      }

      // 回填内存缓存
      this.memoryCache.set(nk, entry)
      this.pruneMemoryIfNeeded()
      this.diskHits++
      return entry
    } catch {
      // 磁盘缓存不存在或读取失败
      return null
    }
  }

  /** 设置缓存条目 */
  async set(entry: CacheEntry): Promise<void> {
    const nk = normalizeKey(entry.key)

    // Level 1: 内存缓存
    this.memoryCache.set(nk, entry)
    this.pruneMemoryIfNeeded()

    // Level 2: 磁盘缓存
    try {
      await fs.promises.mkdir(this.diskDir, { recursive: true })
      const diskPath = path.join(this.diskDir, nk + '.json')
      await fs.promises.writeFile(diskPath, JSON.stringify(entry, null, 2), 'utf-8')
    } catch {
      // 磁盘写入失败不影响功能
    }
  }

  /** 批量设置 */
  async setMany(entries: CacheEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.set(entry)
    }
  }

  /** 检查缓存中是否存在 key */
  has(key: string): boolean {
    return this.memoryCache.has(normalizeKey(key))
  }

  /** 清除内存缓存 */
  clearMemory(): void {
    this.memoryCache.clear()
  }

  /** 清除磁盘缓存 */
  async clearDisk(): Promise<void> {
    try {
      if (fs.existsSync(this.diskDir)) {
        await fs.promises.rm(this.diskDir, { recursive: true, force: true })
      }
    } catch {
      // ignore
    }
  }

  /** 清除过期磁盘缓存 */
  async cleanupExpired(): Promise<void> {
    try {
      if (!fs.existsSync(this.diskDir)) return
      const files = await fs.promises.readdir(this.diskDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const filePath = path.join(this.diskDir, file)
        try {
          const content = await fs.promises.readFile(filePath, 'utf-8')
          const entry: CacheEntry = JSON.parse(content)
          if (Date.now() - entry.timestamp > this.diskTtlMs) {
            await fs.promises.unlink(filePath)
          }
        } catch {
          // 跳过损坏的缓存文件
        }
      }
    } catch {
      // ignore
    }
  }

  /** 获取缓存统计信息 */
  getStats(): CacheStats {
    return {
      memoryHits: this.memoryHits,
      diskHits: this.diskHits,
      misses: this.memoryMisses,
      size: this.memoryCache.size,
    }
  }

  /** 生成缓存 key */
  static makeKey(args: {
    fileHash: string
    rule: string
    provider: string
    model: string
    /** issue 行号，避免同文件同规则多 issue 共用同一缓存 */
    line?: number
  }): string {
    return computeHash(`${args.fileHash}:${args.rule}:${args.line ?? 0}:${args.provider}:${args.model}`)
  }

  /** 生成源码内容的 hash（用于缓存 key） */
  static makeSourceHash(source: string, rule: string): string {
    const normalized = source.trim().replace(/\r\n/g, '\n')
    return computeHash(normalized)
  }

  private pruneMemoryIfNeeded(): void {
    if (this.memoryCache.size > this.memoryMaxSize) {
      // 淘汰最早访问的条目
      const toRemove = this.memoryCache.size - Math.floor(this.memoryMaxSize * 0.8)
      const entries = Array.from(this.memoryCache.entries())
      for (let i = 0; i < toRemove; i++) {
        this.memoryCache.delete(entries[i]![0])
      }
    }
  }
}
