/**
 * AIDE - 核心模块测试
 * Scanner、utils、local-prefilter
 */

import { describe, it, expect } from 'vitest'
import { getLineNumber, escapeRegex, extractBlockBody } from '../src/core/utils.js'
import { localPrefilter } from '../src/core/local-prefilter.js'
import { createDetectors, createPreviewDetectors, getAllDetectorInfo, createDetectorsByRules } from '../src/detectors/index.js'
import { loadAideRc } from '../src/core/config.js'
import type { Issue } from '../src/types/index.js'

// ===== Utils =====
describe('utils', () => {
  describe('getLineNumber', () => {
    it('应正确计算行号', () => {
      const code = 'abc\ndef\nghi'
      expect(getLineNumber(code, 0)).toBe(1)    // 'a'
      expect(getLineNumber(code, 4)).toBe(2)    // 'd'
      expect(getLineNumber(code, 8)).toBe(3)    // 'g'
    })
  })

  describe('escapeRegex', () => {
    it('应转义正则特殊字符', () => {
      expect(escapeRegex('foo.bar')).toBe('foo\\.bar')
      expect(escapeRegex('a+b*c?')).toBe('a\\+b\\*c\\?')
      expect(escapeRegex('normal')).toBe('normal')
    })
  })

  describe('extractBlockBody', () => {
    it('应正确提取花括号块内容', () => {
      const source = 'function foo() { return 42; }'
      // 找到函数体的 {（跳过 () 后的第一个 {）
      const braceIdx = source.indexOf('{', source.indexOf(')'))
      const body = extractBlockBody(source, braceIdx)
      expect(body).not.toBeNull()
      expect(body!).toContain('return 42;')
    })

    it('应忽略字符串中的花括号', () => {
      const source = 'function foo() { return "{nested}"; }'
      const braceIdx = source.indexOf('{', source.indexOf(')'))
      const body = extractBlockBody(source, braceIdx)
      expect(body).not.toBeNull()
      expect(body!).toContain('return "{nested}";')
    })

    it('应忽略注释中的花括号', () => {
      const source = 'function foo() { /* {comment} */ return 1; }'
      const braceIdx = source.indexOf('{', source.indexOf(')'))
      const body = extractBlockBody(source, braceIdx)
      expect(body).not.toBeNull()
      expect(body!).toContain('return 1;')
    })
  })
})

// ===== Local Prefilter =====
describe('localPrefilter', () => {
  it('应过滤布尔前缀函数返回 true/false 的误报', () => {
    const issues: Issue[] = [{
      rule: 'stub-function',
      severity: 'high',
      category: 'ai-code',
      file: 'test.ts',
      line: 1,
      message: 'Stub function "isValid" only returns simple value: return true',
      snippet: 'function isValid() { return true; }',
    }]
    const result = localPrefilter(issues)
    expect(result.removed).toBe(1)
    expect(result.filtered).toHaveLength(0)
  })

  it('应保留真实问题', () => {
    const issues: Issue[] = [{
      rule: 'api-hallucination',
      severity: 'high',
      category: 'hallucination',
      file: 'test.ts',
      line: 1,
      message: 'API hallucination: "Object.map()" does not exist',
      snippet: 'Object.map(obj, fn)',
    }]
    const result = localPrefilter(issues)
    expect(result.filtered).toHaveLength(1)
  })

  it('应过滤 dunder 方法的空实现误报', () => {
    const issues: Issue[] = [{
      rule: 'empty-impl',
      severity: 'medium',
      category: 'ai-code',
      file: 'test.py',
      line: 5,
      message: '__init__ method is empty',
      snippet: 'def __init__(self): pass',
    }]
    const result = localPrefilter(issues)
    expect(result.removed).toBe(1)
  })
})

// ===== Detector Registry =====
describe('detector registry', () => {
  it('createDetectors 应返回 14 个稳定检测器', () => {
    const detectors = createDetectors()
    expect(detectors.length).toBe(14)
  })

  it('createPreviewDetectors 应返回 2 个预览检测器', () => {
    const detectors = createPreviewDetectors()
    expect(detectors.length).toBe(2)
  })

  it('getAllDetectorInfo 应返回所有检测器元信息', () => {
    const info = getAllDetectorInfo()
    expect(info.length).toBe(16)
    expect(info.some(d => d.rule === 'security')).toBe(true)
    expect(info.some(d => d.preview === true)).toBe(true)
  })

  it('createDetectorsByRules 应只返回指定规则', () => {
    const detectors = createDetectorsByRules(['security', 'fake-url'])
    expect(detectors.length).toBe(2)
    expect(detectors.map(d => d.rule).sort()).toEqual(['fake-url', 'security'])
  })
})

// ===== Config =====
describe('config', () => {
  it('loadAideRc 在无配置文件时应返回空配置', () => {
    const config = loadAideRc('/nonexistent/path')
    expect(config).toBeDefined()
  })

  it('CLI 参数应覆盖 rc 配置', () => {
    const config = loadAideRc('/nonexistent/path', { strict: true, offline: true })
    expect(config.strict).toBe(true)
    expect(config.offline).toBe(true)
  })
})
