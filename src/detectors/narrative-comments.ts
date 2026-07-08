/**
 * AIDE - 叙事注释检测器
 * 检测 AI 生成代码中给自解释代码写冗余注释的模式
 *
 * 典型模式：
 *   // 检查用户是否已登录并返回结果
 *   function checkUserLogin(user: User): boolean {
 *     return user.isLoggedIn;
 *   }
 *
 * 排除：
 *   - JSDoc / docstring（slash-star-star ... star-slash 或三引号）
 *   - TODO / FIXME / HACK / NOTE / XXX 标记
 *   - 类型注解说明（@param, @returns, @throws）
 *   - 代码意图注释（解释"为什么"而非"做什么"）
 *   - 配置/魔法数字说明
 *   - 测试文件中的注释
 */

import { stripCommentAfter } from '../core/type-inferencer.js'
import { getLineNumber } from '../core/utils.js'
import { isTestFile } from '../types/index.js'
import type { Detector, DetectorContext, Issue } from '../types/index.js'

/** 有意义的注释标记（不应被报告） */
const MEANINGFUL_MARKERS = /\b(?:TODO|FIXME|HACK|NOTE|XXX|WARNING|BUG|OPTIMIZE|REVIEW|NOSONAR)\b/i

/** 分隔符/区域标记（不应被报告） */
const SECTION_DIVIDERS = /^[=\-]{3,}|^\*{3,}|^#{3,}/

/** JSDoc / docstring 标记 */
const DOC_MARKERS = /@(?:param|returns?|throws?|see|example|deprecated|since|internal|public|private|protected|readonly)/

/** AI 叙事模式关键词 */
const NARRATIVE_PATTERNS = [
  // "做什么" 的描述（中文，不需要 \b 因为中文没有单词边界）
  /(?:检查|获取|设置|创建|删除|更新|处理|计算|验证|返回|调用|执行|初始化|加载|保存|发送|接收|解析|转换|格式化|排序|过滤|搜索|匹配|比较|合并|拆分|复制|移动|重命名|清空|重置)/,
  // 英语 "做什么" 的描述
  /\b(?:check|get|set|create|delete|update|process|calculate|validate|return|call|execute|initialize|load|save|send|receive|parse|convert|format|sort|filter|search|match|compare|merge|split|copy|move|rename|clear|reset|fetch|handle|compute|generate|build|extract|assign|register|trigger|invoke|perform)\b/i,
]

/** "为什么" 的注释模式（不应被报告） */
const WHY_PATTERNS = [
  // 中文因果/目的连词（无单词边界，直接匹配子串）
  /(?:因为|由于|为了|为着|原因是|之所以|以致|以免|以防|以防万一|万一|以防不测)/,
  /\b(?:because|since|due to|in order to|so that|the reason|workaround|fallback|compatibility)\b/i,
  // 中文 "为什么" 主题词（性能/安全/兼容性等说明性注释）
  /(?:性能|安全|兼容|历史|临时|权宜|不得已|已知问题|已知缺陷|已知限制|特殊情况|特殊处理)/,
  /\b(?:performance|security|compat|legacy|temporary|workaround|hotfix)\b/i,
  // 引用外部资源
  /(?:https?:\/\/|RFC|issue|PR|ticket|JIRA|stackoverflow|github\.com)/i,
]

/** 业务/算法意图注释模式（不应被报告——解释了业务规则或算法意图） */
const BUSINESS_INTENT_PATTERNS = [
  // 业务规则/状态机
  /(?:状态|阶段|流程|规则|策略|条件|模式|场景|逻辑|顺序|优先级|降级|回退|事务|并发|锁|幂等)/,
  /\b(?:state|phase|flow|rule|strategy|condition|pattern|scenario|logic|priority|fallback|degrade|transaction|concurrent|lock|idempoten)\b/i,
  // 算法/数据结构意图
  /(?:排序|比较|查找|遍历|递归|分治|动态规划|贪心|回溯|剪枝|哈希|索引|缓存|批量|分片|分页)/,
  /\b(?:sort|compare|search|traverse|recur|divide.conquer|dynamic.program|greedy|backtrack|prun|hash|index|batch|shard|paginat)\b/i,
  // 时区/编码/格式等跨系统问题
  /(?:时区|编码|格式|序列化|反序列化|字符集|UTC|GMT|ISO)/,
  /\b(?:timezone|encoding|format|serializ|charset|UTF|ISO)\b/i,
  // 防御性编程说明
  /(?:防御|容错|兜底|保底|边界|溢出|空值|异常|重试|超时|断路|熔断|限流)/,
  /\b(?:defensive|toleran|fallback|boundary|overflow|null|retry|timeout|circuit.break|rate.limit|throttl)\b/i,
  // 消息队列/任务调度/事件驱动（多词短语，避免误匹配单个动词）
  /(?:消息队列|任务队列|任务调度|定时任务|事件驱动|事件溯源|发布订阅|生产消费|消费组|死信队列)/,
  /\b(?:message.queue|task.queue|task.schedul|cron.job|event.driven|event.sourc|pub.sub|producer.consumer|dead.letter)\b/i,
  // 数据同步/迁移/清洗（多词短语）
  /(?:数据同步|数据迁移|数据清洗|数据聚合|数据去重|数据采样|批量导入|批量导出|数据脱敏)/,
  /\b(?:data.sync|data.migrat|data.clean|data.aggregat|data.dedup|batch.import|batch.export|data.mask)\b/i,
  // 用户/权限/角色/认证/授权（多词短语，避免误匹配"用户"单字）
  /(?:权限模型|角色继承|认证流程|授权策略|多租户|权限分级|角色权限|用户分组)/,
  /\b(?:role.inherit|auth.flow|auth.strategy|multi.tenant|permission.level|user.group)\b/i,
]

/** 魔法数字/配置说明模式（不应被报告） */
const CONFIG_PATTERNS = [
  /\b(?:超时|重试|限制|阈值|缓冲|缓存|间隔|频率)\b/,
  /\b(?:timeout|retry|limit|threshold|buffer|cache|interval|frequency|max|min|batch)\b/i,
  /\d+\s*(?:ms|秒|分钟|hours?|seconds?|minutes?|px|rem|em|%|MB|KB|GB)\b/i,
]

export class NarrativeCommentsDetector implements Detector {
  rule = 'narrative-comments'
  category = 'ai-code' as const
  description = '检测叙事注释（给自解释代码写冗余注释的 AI 典型模式）'
  severity = 'low' as const

  detect(ctx: DetectorContext): Issue[] {
    const { source, language, filePath } = ctx

    // 跳过测试文件
    if (isTestFile(filePath)) return []

    switch (language) {
      case 'typescript':
      case 'javascript':
      case 'java':
      case 'go':
      case 'rust':
      case 'kotlin':
      case 'swift':
      case 'c':
      case 'cpp':
      case 'csharp':
      case 'php':
        return this.detectCLike(source, filePath, language)
      case 'python':
      case 'ruby':
        return this.detectPythonRuby(source, filePath, language)
      default:
        return []
    }
  }

  /** 检测 C 风格语言的叙事注释（// 和 /* *\/） */
  private detectCLike(source: string, filePath: string, language: string): Issue[] {
    const issues: Issue[] = []
    const lines = source.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // 匹配行注释 //
      const lineCommentMatch = /^\/\/\s*(.+)$/.exec(line)
      if (lineCommentMatch) {
        const commentText = lineCommentMatch[1]
        if (this.isNarrativeComment(commentText, language)) {
          // 检查下一行是否有代码
          const nextCodeLine = this.getNextCodeLine(lines, i + 1)
          if (nextCodeLine && this.commentDescribesCode(commentText, nextCodeLine)) {
            issues.push(this.createIssue(filePath, source, this.getLineIndex(source, i), commentText, line))
          }
        }
        continue
      }

      // 匹配行内注释 code // comment
      const inlineComment = this.getInlineComment(line, '//')
      if (inlineComment) {
        const commentText = inlineComment
        if (this.isNarrativeComment(commentText, language)) {
          issues.push(this.createIssue(filePath, source, this.getLineIndex(source, i), commentText, line))
        }
        continue
      }

      // 匹配块注释 /* ... */（单行）
      const blockCommentMatch = /^\/\*\s*(.+?)\s*\*\/$/.exec(line)
      if (blockCommentMatch) {
        const commentText = blockCommentMatch[1]
        // 排除 JSDoc
        if (/^\*/.test(commentText)) continue
        if (this.isNarrativeComment(commentText, language)) {
          const nextCodeLine = this.getNextCodeLine(lines, i + 1)
          if (nextCodeLine && this.commentDescribesCode(commentText, nextCodeLine)) {
            issues.push(this.createIssue(filePath, source, this.getLineIndex(source, i), commentText, line))
          }
        }
      }
    }

    return issues
  }

  /** 检测 Python/Ruby 的叙事注释（# 和文档字符串） */
  private detectPythonRuby(source: string, filePath: string, language: string): Issue[] {
    const issues: Issue[] = []
    const lines = source.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // 匹配 # 注释
      const hashCommentMatch = /^#\s*(.+)$/.exec(line)
      if (hashCommentMatch) {
        const commentText = hashCommentMatch[1]
        if (this.isNarrativeComment(commentText, language)) {
          const nextCodeLine = this.getNextCodeLine(lines, i + 1)
          if (nextCodeLine && this.commentDescribesCode(commentText, nextCodeLine)) {
            issues.push(this.createIssue(filePath, source, this.getLineIndex(source, i), commentText, line))
          }
        }
        continue
      }

      // 匹配行内 # 注释
      const inlineHash = this.getInlineComment(line, '#')
      if (inlineHash) {
        const commentText = inlineHash
        if (this.isNarrativeComment(commentText, language)) {
          issues.push(this.createIssue(filePath, source, this.getLineIndex(source, i), commentText, line))
        }
      }
    }

    return issues
  }

  private getInlineComment(line: string, marker: string): string | null {
    const codePart = stripCommentAfter(line, marker)
    if (codePart === line || codePart.trim() === '') return null
    const commentText = line.slice(codePart.length + marker.length).trim()
    return commentText || null
  }

  /** 判断注释是否为叙事注释 */
  private isNarrativeComment(text: string, _language: string): boolean {
    const trimmed = text.trim()

    // 太短的注释不算（中文 4 字以上，英文 8 字以上）
    if (/[\u4e00-\u9fff]/.test(trimmed)) {
      if (trimmed.length < 4) return false
    } else {
      if (trimmed.length < 8) return false
    }

    // 排除分隔符/区域标记
    if (SECTION_DIVIDERS.test(trimmed)) return false

    // 排除有意义的标记
    if (MEANINGFUL_MARKERS.test(trimmed)) return false
    if (DOC_MARKERS.test(trimmed)) return false

    // 排除 "为什么" 注释
    if (WHY_PATTERNS.some(p => p.test(trimmed))) return false

    // 排除业务/算法意图注释（解释了业务规则或算法意图，不是简单重复代码）
    if (BUSINESS_INTENT_PATTERNS.some(p => p.test(trimmed))) return false

    // 排除配置/魔法数字说明
    if (CONFIG_PATTERNS.some(p => p.test(trimmed))) return false

    // 排除纯类型注解（:Type 格式）
    if (/^@\w+/.test(trimmed)) return false

    // 排除禁用注释（eslint-disable, ts-ignore 等）
    if (/\b(?:eslint|ts-ignore|ts-expect-error|@ts-nocheck|noinspection|noinspection|pylint)\b/.test(trimmed)) return false

    // 排除区域标记（#region, #endregion, region, endregion）
    if (/\b(?:region|endregion)\b/i.test(trimmed)) return false

    // 排除编译指示（pragma, coding, encoding）
    if (/\b(?:pragma|coding|encoding|file)\b/i.test(trimmed)) return false

    // 排除代码示例（注释中包含代码语法）
    if (/[`].*[`]/.test(trimmed)) return false
    if (/^(?:import|export|from|const|let|var|function|class|def|func|fn)\s/.test(trimmed)) return false
    if (/^(?:\/\/|#|\/\*).*(?:=>|\{|\}|\(|\))/.test(trimmed)) return false

    // 排除函数/方法说明（描述函数用途的注释）
    if (/(?:函数|方法|接口|类|模块|文件|命令|参数|选项|配置)/.test(trimmed)) return false
    if (/\b(?:function|method|interface|class|module|file|command|param|option|config)\b/i.test(trimmed)) return false

    // 排除代码结构说明（解释代码语法或结构的注释）
    if (/(?:语句|块|表达式|声明|定义|类型|变量|常量|参数|返回值)/.test(trimmed)) return false
    if (/\b(?:statement|block|expression|declaration|definition|type|variable|constant|parameter|return)\b/i.test(trimmed)) return false

    // 排除类型注解说明
    if (/^:\s*\w+/.test(trimmed)) return false
    if (/(?:类型|Type|Interface|Enum)/.test(trimmed)) return false

    // 排除代码示例（包含代码片段的注释）
    if (/[({\[\]})]/.test(trimmed) && /[=<>!]/.test(trimmed)) return false

    // 排除操作说明（描述代码操作的注释）
    if (/(?:过滤|匹配|检查|查找|搜索|解析|提取|转换|处理|更新|删除|添加|创建|初始化|加载|保存|发送|接收|合并|拆分|复制|移动|重命名|清空|重置)/.test(trimmed)) return false
    if (/\b(?:filter|match|check|find|search|parse|extract|convert|process|update|delete|add|create|init|load|save|send|receive|merge|split|copy|move|rename|clear|reset)\b/i.test(trimmed)) return false

    // 排除配置/设置说明
    if (/(?:配置|设置|选项|参数|环境|变量|常量|阈值|限制|超时|重试|缓存|缓冲)/.test(trimmed)) return false
    if (/\b(?:config|setting|option|param|env|variable|constant|threshold|limit|timeout|retry|cache|buffer)\b/i.test(trimmed)) return false

    // 排除数据结构说明
    if (/(?:数组|列表|字典|映射|集合|队列|栈|树|图|链表|哈希)/.test(trimmed)) return false
    if (/\b(?:array|list|dict|map|set|queue|stack|tree|graph|link|hash)\b/i.test(trimmed)) return false

    // 排除算法/流程说明
    if (/(?:排序|遍历|递归|循环|迭代|分治|动态规划|贪心|回溯|剪枝)/.test(trimmed)) return false
    if (/\b(?:sort|traverse|recur|loop|iterat|divide|conquer|dynamic|greedy|backtrack|prune)\b/i.test(trimmed)) return false

    // 排除错误处理说明
    if (/(?:异常|错误|警告|提示|通知|日志|调试|诊断)/.test(trimmed)) return false
    if (/\b(?:exception|error|warn|notice|notification|log|debug|diagnos)\b/i.test(trimmed)) return false

    // 排除安全/权限说明
    if (/(?:安全|权限|认证|授权|加密|解密|令牌|密钥|密码|身份)/.test(trimmed)) return false
    if (/\b(?:security|permission|auth|encrypt|decrypt|token|key|password|identity)\b/i.test(trimmed)) return false

    // 排除性能/优化说明
    if (/(?:性能|优化|缓存|延迟|并发|并行|异步|同步|批量|分页)/.test(trimmed)) return false
    if (/\b(?:performance|optim|cache|lazy|concurr|parallel|async|sync|batch|page)\b/i.test(trimmed)) return false

    // 排除代码操作说明（描述代码具体操作的注释）
    if (/(?:检测|跳过|过滤|匹配|检查|查找|搜索|解析|提取|转换|处理|更新|删除|添加|创建|初始化|加载|保存|发送|接收|合并|拆分|复制|移动|重命名|清空|重置)/.test(trimmed)) return false
    if (/\b(?:detect|skip|filter|match|check|find|search|parse|extract|convert|process|update|delete|add|create|init|load|save|send|receive|merge|split|copy|move|rename|clear|reset)\b/i.test(trimmed)) return false

    // 排除包含代码语法的注释（如 .unwrap()、.get()、.then/.catch）
    if (/\.\w+\(/.test(trimmed)) return false
    if (/\w+\.\w+/.test(trimmed)) return false

    // 排除正则表达式模式注释
    if (/^\/.*\/[gimsuy]*$/.test(trimmed)) return false
    if (/^\/.*\//.test(trimmed) && /[gimsuy]/.test(trimmed)) return false

    // 检查是否匹配叙事模式
    return NARRATIVE_PATTERNS.some(p => p.test(trimmed))
  }

  /** 判断注释是否在描述紧随其后的代码 */
  private commentDescribesCode(comment: string, codeLine: string): boolean {
    const trimmedCode = codeLine.trim()
    if (!trimmedCode) return false

    // 叙事注释 + 紧随其后的代码 = 大概率在描述代码
    // 只需排除明显不相关的情况（如注释是关于上一行代码的）

    // 从注释中提取关键词
    const commentWords = comment
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)

    // 从代码中提取标识符
    const codeIdentifiers = trimmedCode
      .toLowerCase()
      .replace(/[^\w]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)

    // 如果注释中的关键词与代码标识符有重叠，说明注释在描述代码
    const overlap = commentWords.filter(w => codeIdentifiers.includes(w))
    if (overlap.length > 0) return true

    // 检查函数名是否与注释语义匹配
    // 覆盖多种语言的函数/方法声明语法：
    //   JS/TS:  function foo() / function* foo()
    //   Python: def foo() / async def foo()
    //   Go:     func foo()
    //   Rust:   fn foo() / pub fn foo() / async fn foo()
    //   Java/C#/C++: [modifiers] returnType foo() —— 用通用启发式
    const funcNameMatch = /(?:^|\s)(?:function\*?|def|func|fn)\s+(\w+)/.exec(trimmedCode)
      || /(?:^|\s)(?:public|private|protected|static|final|abstract|override|async|pub|unsafe|extern)?\s*(?:public|private|protected|static|final|abstract|override)?\s*[\w<>\[\],\s:]+?\s+(\w+)\s*\(/.exec(trimmedCode)
    if (funcNameMatch) {
      const funcName = funcNameMatch[1]
      // 将函数名拆分为单词（camelCase / snake_case）
      const funcWords = funcName
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2)

      const funcOverlap = commentWords.filter(w => funcWords.includes(w))
      if (funcOverlap.length > 0) return true

      // 中文注释与英文函数名的语义匹配
      // 如果注释包含动词+名词模式，且函数名也包含对应语义，则匹配
      if (this.chineseEnglishSemanticMatch(comment, funcName)) return true
    }

    // 变量名匹配
    const varNameMatch = /(?:const|let|var|int|float|double|string|bool)\s+(\w+)/.exec(trimmedCode)
    if (varNameMatch) {
      const varName = varNameMatch[1]
      const varWords = varName
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2)

      const varOverlap = commentWords.filter(w => varWords.includes(w))
      if (varOverlap.length > 0) return true

      // 中文注释与英文变量名的语义匹配
      if (this.chineseEnglishSemanticMatch(comment, varName)) return true
    }

    // 兜底：注释关键词与紧随的代码无任何重叠，无法证明注释在描述代码。
    // 宁可漏报（放过真正冗余的注释）也不误报（误伤有意义的注释）。
    return false
  }

  /** 中文注释与英文标识符的语义匹配 */
  private chineseEnglishSemanticMatch(comment: string, identifier: string): boolean {
    // 中文动词 → 英文前缀映射
    const verbMap: Record<string, string[]> = {
      '获取': ['get', 'fetch', 'load', 'read', 'retrieve'],
      '设置': ['set', 'update', 'write', 'assign'],
      '检查': ['check', 'validate', 'verify', 'is', 'has', 'can'],
      '创建': ['create', 'new', 'init', 'build', 'make'],
      '删除': ['delete', 'remove', 'destroy', 'drop', 'clear'],
      '更新': ['update', 'modify', 'change', 'patch'],
      '处理': ['process', 'handle', 'deal'],
      '计算': ['calculate', 'compute', 'calc'],
      '验证': ['validate', 'verify', 'check'],
      '返回': ['return', 'get'],
      '调用': ['call', 'invoke', 'execute'],
      '执行': ['execute', 'run', 'perform'],
      '初始化': ['init', 'initialize', 'setup'],
      '加载': ['load', 'fetch', 'read'],
      '保存': ['save', 'store', 'persist'],
      '发送': ['send', 'dispatch', 'emit'],
      '接收': ['receive', 'accept'],
      '解析': ['parse', 'decode'],
      '转换': ['convert', 'transform', 'translate'],
      '格式化': ['format'],
      '排序': ['sort'],
      '过滤': ['filter'],
      '搜索': ['search', 'find', 'query'],
      '匹配': ['match'],
      '比较': ['compare'],
      '合并': ['merge', 'combine', 'join'],
      '拆分': ['split', 'divide'],
      '复制': ['copy', 'clone'],
      '清空': ['clear', 'reset'],
      '重置': ['reset', 'clear'],
    }

    const idLower = identifier.toLowerCase()

    // 1) 动词匹配：注释含中文动词，且英文标识符包含对应英文动词
    for (const [cnVerb, enVerbs] of Object.entries(verbMap)) {
      if (comment.includes(cnVerb)) {
        if (enVerbs.some(v => idLower.startsWith(v) || idLower.includes(v))) {
          return true
        }
      }
    }

    // 2) 名词匹配：中文注释与英文标识符共享名词语义。
    //    将英文标识符拆词（userData → user/data）后，若注释中能匹配到
    //    对应中文名词（用户/数据），认为注释在描述该标识符。
    //    这是高精度规则：要求 camelCase/snake_case 拆分后的英文词与
    //    注释里的中文词一一对应，不会误伤无关联的注释。
    const nounMap: Record<string, string> = {
      '用户': 'user', '数据': 'data', '信息': 'info', '配置': 'config',
      '请求': 'request', '响应': 'response', '结果': 'result',
      '列表': 'list', '数组': 'array', '字典': 'dict', '映射': 'map',
      '文件': 'file', '目录': 'dir', '路径': 'path',
      '连接': 'connection', '数据库': 'database', '缓存': 'cache',
      '会话': 'session', '令牌': 'token', '密钥': 'key',
      '错误': 'error', '异常': 'exception', '日志': 'log',
      '状态': 'state', '名称': 'name',
      '时间': 'time', '日期': 'date', '计数': 'count',
      '索引': 'index', '值': 'value', '类型': 'type',
      '消息': 'message', '事件': 'event', '任务': 'task',
      '订单': 'order', '商品': 'product', '价格': 'price',
      '权限': 'permission', '角色': 'role', '菜单': 'menu',
    }
    const idWords = identifier
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)
    for (const [cnNoun, enNoun] of Object.entries(nounMap)) {
      if (comment.includes(cnNoun) && idWords.includes(enNoun)) {
        return true
      }
    }

    return false
  }

  /** 获取下一行有意义的代码 */
  private getNextCodeLine(lines: string[], startIdx: number): string | null {
    for (let i = startIdx; i < Math.min(lines.length, startIdx + 3); i++) {
      const trimmed = lines[i].trim()
      // 跳过空行和其他注释
      if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) continue
      return trimmed
    }
    return null
  }

  private createIssue(filePath: string, source: string, index: number, commentText: string, snippet: string): Issue {
    return {
      rule: this.rule,
      severity: 'low',
      confidence: 'low',
      category: 'ai-code',
      file: filePath,
      line: getLineNumber(source, index),
      message: `叙事注释：代码已自解释，注释冗余`,
      snippet: snippet.trim(),
      suggestion: `删除此注释，或改为解释"为什么"而非"做什么"`,
    }
  }

  private getLineIndex(source: string, lineNum: number): number {
    let idx = 0
    for (let i = 0; i < lineNum; i++) {
      const nextNewline = source.indexOf('\n', idx)
      if (nextNewline === -1) return source.length
      idx = nextNewline + 1
    }
    return idx
  }
}
