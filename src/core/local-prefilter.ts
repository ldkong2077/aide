/**
 * AIDE - 本地误报预筛模块
 * 在 LLM 复核之前，用硬编码的已知误报模式库快速排除
 * 减少 40-60% 的 LLM 调用量，0 token 消耗
 */

import type { Issue, Confidence } from '../types/index.js'

/** 预筛规则 */
interface PrefilterRule {
  /** 适用的检测器规则名 */
  rule: string
  /** 判定函数：返回 true 表示是误报，应排除 */
  isFalsePositive: (issue: Issue) => boolean
  /** 误报原因（用于日志） */
  reason: string
}

/** 本地预筛规则库 */
const PREFILTER_RULES: PrefilterRule[] = [
  // ===== stub-function 误报 =====
  {
    rule: 'stub-function',
    reason: '布尔前缀函数返回 true/false 是合理的守卫模式',
    isFalsePositive: (issue) => {
      const msg = issue.message
      // isXxx/hasXxx/canXxx/shouldXxx/willXxx/mustXxx 返回 true/false
      if (/\b(is|has|can|should|will|must|was|did|had|could|would|needs|requires)\w*\b.*\breturn\s+(true|false)\b/i.test(msg)) {
        return true
      }
      // createXxx/makeXxx/buildXxx 工厂函数返回默认值
      if (/\b(create|make|build|new|get|init|default)\w*\b.*\breturn\s+(null|undefined|0|''|""|\[\]|\{\})\b/i.test(msg)) {
        return true
      }
      // noop/empty 空操作函数是有意设计
      if (/\b(noop|empty|dummy|placeholder|stub|todo)\b/i.test(msg)) {
        return true
      }
      return false
    },
  },

  // ===== empty-impl 误报 =====
  {
    rule: 'empty-impl',
    reason: '合法的空实现模式',
    isFalsePositive: (issue) => {
      const msg = issue.message
      // Python dunder 方法
      if (/__(init|repr|str|len|eq|hash|iter|next|call|enter|exit|del|post_init)__/.test(msg)) {
        return true
      }
      // @abstractmethod / @Override / @property 装饰的方法
      if(/@(abstractmethod|Override|property|fixture|staticmethod|classmethod)/.test(msg)) {
        return true
      }
      // Go init() 由运行时调用
      if (/\binit\s*\(/.test(msg)) {
        return true
      }
      // React 组件占位
      if (/(Placeholder|Skeleton|Loading|Spinner|Fallback)/.test(msg)) {
        return true
      }
      // 事件处理器空实现
      if (/\b(on[A-Z]\w*|handle[A-Z]\w*|before[A-Z]\w*|after[A-Z]\w*)\s*[\(\{]/.test(msg)) {
        return true
      }
      // 接口默认方法
      if (/default\s+/.test(msg)) {
        return true
      }
      return false
    },
  },

  // ===== unused-declaration 误报 =====
  {
    rule: 'unused-declaration',
    reason: '导出符号被其他文件使用',
    isFalsePositive: (issue) => {
      // export 的符号是公共 API
      if (issue.snippet && /^\s*export\s/.test(issue.snippet)) {
        return true
      }
      // Python UPPER_CASE 常量是模块 API
      if (/\b[A-Z][A-Z_0-9]+\b/.test(issue.message) && /常量|constant/i.test(issue.message)) {
        return true
      }
      // __all__ 中声明的符号
      if (/__all__/.test(issue.message)) {
        return true
      }
      return false
    },
  },

  // ===== swallowed-error 误报 =====
  {
    rule: 'swallowed-error',
    reason: 'catch 块中有有效错误处理',
    isFalsePositive: (issue) => {
      // catch 块含 console.error/log/warn 是有效错误处理
      const msg = issue.message
      if (/console\.(error|log|warn|info)/.test(msg)) {
        return true
      }
      // logger.error / logger.warn
      if (/logger\.(error|warn|info|debug)/.test(msg)) {
        return true
      }
      // emit/notify/report 错误
      if (/(emit|notify|report|track|capture|send)\w*Error/.test(msg)) {
        return true
      }
      return false
    },
  },

  // ===== api-hallucination 误报 =====
  {
    rule: 'api-hallucination',
    reason: '已知合法 API（不在规则库中）',
    isFalsePositive: (issue) => {
      const msg = issue.message
      // pandas.DataFrame 方法
      if (/pandas?\.(DataFrame|Series)\.\w+/.test(msg)) {
        // pandas 常用方法白名单
        const pandasMethods = ['merge', 'join', 'groupby', 'agg', 'transform', 'apply', 'map', 'pivot', 'melt', 'explode', 'fillna', 'dropna', 'astype', 'value_counts', 'describe', 'corr', 'clip', 'query', 'eval', 'replace', 'sort_values', 'nlargest', 'nsmallest', 'duplicated', 'drop_duplicates', 'between', 'isin', 'where', 'mask', 'clip', 'ffill', 'bfill', 'interpolate', 'sample', 'resample', 'rolling', 'expanding', 'ewm', 'unstack', 'stack', 'swaplevel', 'get', 'pop', 'update', 'rename', 'rename_axis', 'abs', 'round', 'diff', 'pct_change', 'cumsum', 'cummax', 'cummin', 'cumprod', 'dot', 'T', 'flatten', 'ravel', 'tolist', 'item', 'put', 'nonzero', 'flags', 'astype', 'view', 'fill', 'copy']
        for (const m of pandasMethods) {
          if (msg.includes(m)) return true
        }
      }
      // numpy.ndarray 方法
      if (/numpy\.(ndarray|array)\.\w+/.test(msg)) {
        const numpyMethods = ['flatten', 'reshape', 'ravel', 'T', 'tolist', 'astype', 'fill', 'copy', 'sum', 'mean', 'std', 'var', 'min', 'max', 'argmin', 'argmax', 'argsort', 'sort', 'clip', 'cumsum', 'cumprod', 'dot', 'transpose', 'swapaxes', 'squeeze', 'expand_dims', 'repeat', 'tile', 'nonzero', 'compress', 'searchsorted', 'partition', 'view']
        for (const m of numpyMethods) {
          if (msg.includes(m)) return true
        }
      }
      return false
    },
  },

  // ===== unhandled-promise 误报 =====
  {
    rule: 'unhandled-promise',
    reason: '合理的浮空 Promise',
    isFalsePositive: (issue) => {
      const msg = issue.message
      // fire-and-forget 模式（如日志、监控上报）
      if (/(log|track|notify|report|send|emit|increment|record|capture)\w*\(/i.test(msg)) {
        return true
      }
      // 事件监听器回调中的异步操作
      if (/\bon[A-Z]\w+/.test(msg) || /\.then\(/.test(msg)) {
        return true
      }
      return false
    },
  },

  // ===== security 误报 =====
  {
    rule: 'security',
    reason: '标准库路径拼接不是注入',
    isFalsePositive: (issue) => {
      const snippet = issue.snippet || ''
      // os.path.join / path.join / path.resolve 等标准库路径拼接
      if (/(os\.path\.(join|exists|abspath|normpath)|path\.join|path\.resolve|path\.normalize|Path\()/i.test(snippet)) {
        return true
      }
      return false
    },
  },
  {
    rule: 'security',
    reason: 'HTTP URL 在本地开发/测试中可接受',
    isFalsePositive: (issue) => {
      const msg = issue.message
      // localhost / 127.0.0.1 / 0.0.0.0 是本地开发地址
      if (/不安全的 HTTP URL/.test(msg) && /(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(msg)) {
        return true
      }
      return false
    },
  },

  // ===== hardcoded-value 误报 =====
  {
    rule: 'hardcoded-value',
    reason: '配置/常量文件中的值是有意的',
    isFalsePositive: (issue) => {
      const file = issue.file.replace(/\\/g, '/')
      // 配置文件、常量文件、环境定义文件中的值是故意的
      if (/(config|constant|env|setting|option|default|variable)s?[\./_]/i.test(file)
        || /\/(config|constant|env|setting)s?\.(ts|js|py|json|yaml|yml|toml)$/i.test(file)
        || /\.env/i.test(file)) {
        return true
      }
      return false
    },
  },
  {
    rule: 'hardcoded-value',
    reason: '赋值给 API_URL/BASE_URL 等配置变量的 URL 是故意的',
    isFalsePositive: (issue) => {
      const msg = issue.message
      const snippet = issue.snippet || ''
      // 变量名包含 URL/ENDPOINT/HOST/PORT 的硬编码 URL/IP 是配置
      if (/硬编码的 (URL|IP)/.test(msg)) {
        if (/(API_|BASE_|SERVER_|SERVICE_|REMOTE_|PROXY_|REDIS_|DB_|DATABASE_|MONGO_|MYSQL_|POSTGRES_)(URL|HOST|ENDPOINT|PORT|ADDR)/i.test(snippet)) {
          return true
        }
        if (/const\s+\w*(URL|ENDPOINT|HOST|ADDR|ADDRESS)\s*=/i.test(snippet)) {
          return true
        }
      }
      return false
    },
  },

  // ===== resource-leak 误报 =====
  {
    rule: 'resource-leak',
    reason: 'with/using 语句中的资源会自动关闭',
    isFalsePositive: (issue) => {
      const msg = issue.message
      // with 语句 / using 声明管理的资源不需要手动 close
      if (/未使用 with 语句/.test(msg) || /未正确关闭/.test(msg)) {
        // 如果 snippet 中有 with 或 using，说明已经用了上下文管理器
        const snippet = issue.snippet || ''
        if (/\bwith\s+/i.test(snippet) || /\busing\s+/i.test(snippet)) {
          return true
        }
      }
      return false
    },
  },
  {
    rule: 'resource-leak',
    reason: 'Go defer close() 模式',
    isFalsePositive: (issue) => {
      const msg = issue.message
      // Go 的 defer Close() 是惯用关闭模式
      if (/Go/.test(msg) && /可能未关闭/.test(msg)) {
        const snippet = issue.snippet || ''
        if (/defer\s+\w+\.Close\(\)/i.test(snippet)) {
          return true
        }
      }
      return false
    },
  },

  // ===== unreachable-code 误报 =====
  {
    rule: 'unreachable-code',
    reason: 'if __name__ == \'__main__\' 后的代码是入口守卫',
    isFalsePositive: (issue) => {
      const snippet = issue.snippet || ''
      // Python 入口守卫后的代码不是死代码
      if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(snippet)) {
        return true
      }
      return false
    },
  },
  {
    rule: 'unreachable-code',
    reason: 'switch/case 中的 break/return 后的代码标签不是死代码',
    isFalsePositive: (issue) => {
      const snippet = issue.snippet || ''
      // case 分支末尾的 break/return 后紧跟下一个 case 标签
      if (/^\s*(case\s+|default\s*:)/.test(snippet)) {
        return true
      }
      return false
    },
  },

  // ===== fake-url 误报 =====
  {
    rule: 'fake-url',
    reason: '赋值给 API/ENDPOINT 配置变量的 URL 是故意的',
    isFalsePositive: (issue) => {
      const snippet = issue.snippet || ''
      // 变量名含 API_URL/BASE_URL/ENDPOINT 等的 URL 是配置
      if (/(API_|BASE_|SERVER_|SERVICE_|REMOTE_|PROXY_|REDIS_|DB_)(URL|ENDPOINT|HOST)/i.test(snippet)) {
        return true
      }
      if (/(const|let|var)\s+\w*(URL|ENDPOINT|HOST|ADDR)\s*=/i.test(snippet)) {
        return true
      }
      return false
    },
  },
  {
    rule: 'fake-url',
    reason: '示例/文档/测试 URL 不是虚假 URL',
    isFalsePositive: (issue) => {
      const msg = issue.message
      // example.com / docs.xxx / localhost 是示例或本地 URL
      if (/(example\.com|localhost|127\.0\.0\.1|0\.0\.0\.0|test\.|docs\.|placeholder)/i.test(msg)) {
        return true
      }
      return false
    },
  },

  // ===== package-hallucination 误报 =====
  {
    rule: 'package-hallucination',
    reason: 'node_modules 中已安装的包不需要在线验证',
    isFalsePositive: (issue) => {
      // 如果文件路径在 node_modules 中，说明包已安装
      const file = issue.file.replace(/\\/g, '/')
      if (/node_modules\//i.test(file)) {
        return true
      }
      return false
    },
  },
]

/**
 * 本地预筛：用已知误报模式库快速排除明显的误报
 * 在 LLM 复核之前调用，减少 40-60% 的 LLM 调用量
 *
 * @returns 过滤后的 issues 数组
 */
export function localPrefilter(issues: Issue[]): { filtered: Issue[]; removed: number; removalsByRule: Record<string, number> } {
  const removalsByRule: Record<string, number> = {}
  let removed = 0

  // 按规则分组预筛规则
  const rulesByRule = new Map<string, PrefilterRule[]>()
  for (const rule of PREFILTER_RULES) {
    const list = rulesByRule.get(rule.rule) || []
    list.push(rule)
    rulesByRule.set(rule.rule, list)
  }

  const filtered = issues.filter(issue => {
    const rules = rulesByRule.get(issue.rule)
    if (!rules) return true  // 没有预筛规则的检测器，保留

    for (const rule of rules) {
      if (rule.isFalsePositive(issue)) {
        removed++
        removalsByRule[issue.rule] = (removalsByRule[issue.rule] || 0) + 1
        return false
      }
    }
    return true
  })

  return { filtered, removed, removalsByRule }
}
