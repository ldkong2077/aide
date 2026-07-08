/**
 * AIDE - 检测器注册表
 * 统一创建和导出所有检测器
 *
 * 注册约定：
 * - 每个检测器文件 export 一个以 "Detector" 结尾的类
 * - createDetectors() 返回稳定检测器
 * - createPreviewDetectors() 返回预览检测器（需 --preview 启用）
 * - getAllDetectorInfo() 返回所有检测器元信息（用于 --list 等展示）
 */

import type { Detector } from '../types/index.js'
import { PackageHallucinationDetector } from './package-hallucination.js'
import { ApiHallucinationDetector } from './api-hallucination.js'
import { UnreachableCodeDetector } from './unreachable-code.js'
import { UnusedDeclarationDetector } from './unused-declaration.js'
import { FakeUrlDetector } from './fake-url.js'
import { StubFunctionDetector } from './stub-function.js'
import { EmptyImplDetector } from './empty-impl.js'
import { SwallowedErrorDetector } from './swallowed-error.js'
import { UnhandledPromiseDetector } from './unhandled-promise.js'
import { WeakValidationDetector } from './weak-validation.js'
import { HardcodedValueDetector } from './hardcoded-value.js'
import { ResourceLeakDetector } from './resource-leak.js'
import { SecurityDetector } from './security.js'
import { StructureDetector } from './structure.js'
import { NarrativeCommentsDetector } from './narrative-comments.js'
import { DeadCodeDetector } from './dead-code.js'

/** 检测器元信息 */
export interface DetectorInfo {
  rule: string
  description: string
  category: string
  severity: string
  preview: boolean
}

/** 稳定检测器类列表 */
const STABLE_DETECTORS = [
  PackageHallucinationDetector,
  ApiHallucinationDetector,
  UnreachableCodeDetector,
  UnusedDeclarationDetector,
  FakeUrlDetector,
  StubFunctionDetector,
  EmptyImplDetector,
  SwallowedErrorDetector,
  UnhandledPromiseDetector,
  WeakValidationDetector,
  HardcodedValueDetector,
  ResourceLeakDetector,
  SecurityDetector,
  StructureDetector,
]

/** 预览检测器类列表 */
const PREVIEW_DETECTORS = [
  DeadCodeDetector,
  NarrativeCommentsDetector,
]

/** 创建默认检测器（稳定、低误报） */
export function createDetectors(): Detector[] {
  return STABLE_DETECTORS.map(D => new D())
}

/** 创建预览检测器（不稳定，可能产生较多误报，需 --preview 启用） */
export function createPreviewDetectors(): Detector[] {
  return PREVIEW_DETECTORS.map(D => new D())
}

/** 获取所有检测器元信息 */
export function getAllDetectorInfo(): DetectorInfo[] {
  const infos: DetectorInfo[] = []
  for (const D of STABLE_DETECTORS) {
    const instance = new D() as Detector
    infos.push({
      rule: instance.rule,
      description: instance.description,
      category: instance.category,
      severity: instance.severity,
      preview: false,
    })
  }
  for (const D of PREVIEW_DETECTORS) {
    const instance = new D() as Detector
    infos.push({
      rule: instance.rule,
      description: instance.description,
      category: instance.category,
      severity: instance.severity,
      preview: true,
    })
  }
  return infos
}

/**
 * 根据规则名创建指定检测器实例
 * 用于 --only 过滤：只实例化需要的检测器
 */
export function createDetectorsByRules(rules: string[]): Detector[] {
  const ruleSet = new Set(rules)
  const all = [...STABLE_DETECTORS, ...PREVIEW_DETECTORS]
  return all
    .filter(D => ruleSet.has((new D() as Detector).rule))
    .map(D => new D())
}
