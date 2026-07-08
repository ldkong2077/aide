/**
 * AIDE - Python AST 桥接模块
 *
 * 调用 CPython 的 ast 模块获取 100% 准确的 AST 信息。
 * 相比 ast-parser.ts 的缩进猜测，此模块使用官方的 C 级解析器。
 *
 * 设计原则：
 * - 纯文本管道通信（stdin → stdout JSON），不写临时文件
 * - 无外部 npm 依赖，需要系统安装 python3
 * - 解析失败 → 返回 null，调用方降级到正则路径
 * - 运行时缓存: 同一进程内对同一源码字符串只解析一次
 */

import { spawnSync } from 'child_process'

// ==================== 类型定义 ====================

/** Python 函数信息 */
export interface PythonFunction {
  name: string
  startLine: number
  endLine: number
  /** 函数体是否有实际代码（排除 docstring/pass/... 后仍有语句） */
  hasBody: boolean
  /** 函数体总语句数 */
  bodyStatementCount: number
  /** 是否有文档字符串 */
  hasDocstring: boolean
  /** 装饰器名列表 */
  decorators: string[]
  /** 是否在 class 内（是方法） */
  isMethod: boolean
}

/** Python except 处理器 */
export interface PythonExceptHandler {
  /** 异常类型名，空字符串 = bare except */
  type: string
  /** 行号 */
  line: number
  /** 处理器体的有意义代码行数 */
  bodyLineCount: number
  /** 是否有 raise */
  hasRaise: boolean
  /** 是否有 return */
  hasReturn: boolean
  /** 是否有 logger.exception(...) 调用 */
  hasLoggerException: boolean
  /** 是否应视为吞噬（空体 / 仅 pass / 仅 print / 仅 log 无异常引用） */
  isSwallowed: boolean
}

/** Python try 块信息 */
export interface PythonTryBlock {
  startLine: number
  endLine: number
  handlers: PythonExceptHandler[]
}

/** Python AST 解析结果 */
export interface PythonASTResult {
  functions: PythonFunction[]
  tryBlocks: PythonTryBlock[]
}

// ==================== 内嵌 Python 脚本 ====================

/**
 * 嵌入的 Python 脚本。
 * 从 stdin 读取源码 → ast.parse() → 遍历 → 输出 JSON。
 *
 * 为什么不单独放一个 .py 文件？
 * 因为 AIDE 是 npm 包，.py 文件在打包时需要额外配置。
 * 内嵌在 ts 中可以保证始终伴随代码发布。
 */
const PYTHON_SCRIPT = `
import ast, sys, json

src = sys.stdin.read()
try:
    tree = ast.parse(src)
except SyntaxError:
    # 非 Python 文件或语法错误 → 输出空结果
    print(json.dumps({"functions": [], "tryBlocks": []}))
    sys.exit(0)

result = {
    "functions": [],
    "tryBlocks": [],
}

# 全局行偏移：因为 ast 的行号基于模块根，
# + 1 是因为 Python ast 行号从 1 开始
for node in ast.walk(tree):
    # === 收集函数定义 ===
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        # 识别 docstring（第一个语句是 Expr(Constant(str))）
        docstring_count = 0
        if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant) and isinstance(node.body[0].value.value, str):
            docstring_count = 1

        # 计算有意义的语句：排除 docstring、pass、...（Ellipsis）
        # 注意：不再排除 ast.Expr，因为函数调用语句（如 logger.info()）
        # 也是 ast.Expr，它们是有意义的代码
        meaningful = [n for n in node.body if not (
            (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)) or  # docstring
            isinstance(n, ast.Pass) or
            (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and n.value.value is Ellipsis)  # ...
        )]
        has_body = len(meaningful) > 0

        func = {
            "name": node.name,
            "startLine": node.lineno,
            "endLine": getattr(node, 'end_lineno', node.lineno),
            "hasBody": has_body,
            "bodyStatementCount": len(meaningful),
            "hasDocstring": docstring_count > 0,
            "decorators": [d.id if isinstance(d, ast.Name) else (d.attr if isinstance(d, ast.Attribute) else repr(d)) for d in node.decorator_list],
            "isMethod": False,  # 稍后在 walk 中通过上下文设置
        }
        result["functions"].append(func)

    # === 收集 try 块 ===
    if isinstance(node, ast.Try):
        handlers = []
        for h in node.handlers:
            body_lines = []
            has_raise = False
            has_return = False
            has_logger_exception = False

            for stmt in h.body:
                if isinstance(stmt, ast.Raise):
                    has_raise = True
                    body_lines.append("raise")
                elif isinstance(stmt, ast.Return):
                    has_return = True
                    body_lines.append("return")
                elif isinstance(stmt, ast.Pass):
                    body_lines.append("pass")
                elif isinstance(stmt, ast.Expr):
                    if isinstance(stmt.value, ast.Call):
                        # 检查是否是 logger.exception(...)
                        if isinstance(stmt.value.func, ast.Attribute) and stmt.value.func.attr == "exception":
                            has_logger_exception = True
                            body_lines.append("logger.exception")
                        elif isinstance(stmt.value.func, ast.Attribute) and stmt.value.func.attr in ("debug", "info", "warning", "error", "critical", "log"):
                            # 检查是否有异常变量引用
                            call = stmt.value
                            has_exc_ref = False
                            for kw in call.keywords:
                                if isinstance(kw.value, ast.Name) and kw.value.id in ("e", "exc", "err", "exception", "ex"):
                                    has_exc_ref = True
                                    break
                            for arg in call.args:
                                if isinstance(arg, ast.Name) and arg.id in ("e", "exc", "err", "exception", "ex"):
                                    has_exc_ref = True
                                    break
                            if has_logger_exception or has_exc_ref:
                                body_lines.append("logger.exception")
                            else:
                                body_lines.append("logger.plain")
                        else:
                            body_lines.append("other")
                    else:
                        body_lines.append("other")
                elif isinstance(stmt, ast.Assert):
                    # assert 0, e 在某些代码中用于调试
                    body_lines.append("assert")
                else:
                    body_lines.append("other")

            meaningful_lines = [l for l in body_lines if l not in ("pass", "logger.plain")]
            is_swallowed = len(meaningful_lines) == 0

            # 识别合理静默模式：特定异常类型的 pass/... 是标准写法
            if is_swallowed and h.type:
                exc_type_str = ast.unparse(h.type)
                # OSError: 文件操作（文件不存在则跳过，是常见模式）
                # FileNotFoundError / PermissionError: OSError 子类，同理
                # ImportError: 可选依赖检查
                # asyncio.CancelledError: 任务取消
                # KeyboardInterrupt / StopIteration: 系统/迭代控制
                silent_exceptions = {"OSError", "FileNotFoundError", "PermissionError",
                                     "ImportError", "asyncio.CancelledError",
                                     "KeyboardInterrupt", "StopIteration"}
                if exc_type_str in silent_exceptions:
                    is_swallowed = False

            handler_info = {
                "type": ast.unparse(h.type) if h.type else "",
                "line": h.lineno,
                "bodyLineCount": len(body_lines),
                "hasRaise": has_raise,
                "hasReturn": has_return,
                "hasLoggerException": has_logger_exception,
                "isSwallowed": is_swallowed,
            }
            handlers.append(handler_info)

        # 处理 finally 块
        if node.finalbody:
            handlers.append({
                "type": "finally",
                "line": node.finalbody[0].lineno if node.finalbody else node.lineno,
                "bodyLineCount": len(node.finalbody),
                "hasRaise": any(isinstance(s, ast.Raise) for s in node.finalbody),
                "hasReturn": any(isinstance(s, ast.Return) for s in node.finalbody),
                "hasLoggerException": False,
                "isSwallowed": False,
            })

        tb = {
            "startLine": node.lineno,
            "endLine": getattr(node, 'end_lineno', node.lineno),
            "handlers": handlers,
        }
        result["tryBlocks"].append(tb)

# 标记 isMethod: 检查函数是否在 class 定义内
for func in result["functions"]:
    for node2 in ast.walk(tree):
        if isinstance(node2, ast.ClassDef):
            for item in node2.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == func["name"] and item.lineno == func["startLine"]:
                    func["isMethod"] = True
                    break

print(json.dumps(result, ensure_ascii=False))
`.trimStart()

// ==================== 简单内存缓存 ====================

/** 缓存键 = 源码哈希（取前 2000 字符的前 200 个字符，避免巨大文件缓存过重） */
function cacheKey(source: string): string {
  const prefix = source.slice(0, 2000)
  let hash = 0
  for (let i = 0; i < prefix.length; i++) {
    const chr = prefix.charCodeAt(i)
    hash = ((hash << 5) - hash) + chr
    hash |= 0
  }
  return hash.toString(36)
}

const cache = new Map<string, PythonASTResult>()

// ==================== 主接口 ====================

/**
 * 使用 CPython 解析 Python 源码，返回结构化 AST 信息。
 * 返回 null 表示 python3 不可用或解析失败。
 */
export function parsePythonAST(source: string): PythonASTResult | null {
  const key = cacheKey(source)
  const cached = cache.get(key)
  if (cached) return cached

  try {
    const child = spawnSync('python3', ['-c', PYTHON_SCRIPT], {
      input: source,
      encoding: 'utf-8',
      timeout: 10_000,      // 10s timeout
      maxBuffer: 10 * 1024 * 1024,  // 10MB
      windowsHide: true,
    })

    if (child.error || child.status !== 0) {
      // python3 不可用或脚本出错 → 静默降级
      return null
    }

    const stdout = child.stdout.trim()
    if (!stdout) return null

    const parsed = JSON.parse(stdout)

    // 校验结构完整性
    if (!parsed || typeof parsed !== 'object') return null

    const result: PythonASTResult = {
      functions: Array.isArray(parsed.functions) ? parsed.functions : [],
      tryBlocks: Array.isArray(parsed.tryBlocks) ? parsed.tryBlocks : [],
    }

    cache.set(key, result)
    return result
  } catch {
    // spawnSync 本身失败（如 python3 未安装）→ 静默降级
    return null
  }
}

/**
 * 检查 python3 是否可用。
 * 在 scanner 遍历文件前调用一次，避免对每个文件都尝试 spawn。
 */
export function isPythonAvailable(): boolean {
  const result = spawnSync('python3', ['--version'], {
    timeout: 3000,
    windowsHide: true,
  })
  return result.status === 0 && !result.error
}

/**
 * 清空缓存。在长时间运行的进程（watch 模式）中，
 * 如果检测到源码变更可以调用此方法。
 */
export function clearPythonASTCache(): void {
  cache.clear()
}
