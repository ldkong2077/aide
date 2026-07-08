/**
 * AIDE - 语言检测与解析器封装
 */

import * as path from 'path'
import type { Language } from '../types/index.js'

/** 文件扩展名到语言的映射 */
const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.go': 'go',
  '.java': 'java',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.cs': 'csharp',
}

/** 根据文件路径检测语言 */
export function detectLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] || 'unknown'
}

/** 获取所有支持的扩展名 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_TO_LANGUAGE)
}
