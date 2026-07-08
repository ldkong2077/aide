/**
 * 幻觉 API 检测规则
 * 包含各语言常见的 AI 幻觉 API 调用模式
 * 数据来源: hallucination.ts
 */

export interface HallucinatedAPI {
  pattern: string;
  message: string;
  severity: "high" | "medium" | "low" | "info";
  suggestion: string;
  language: string;
}

// ==================== Python 幻觉 API ====================
export const PYTHON_HALLUCINATION_APIS: HallucinatedAPI[] = [
  {
    pattern: "pandas\\.read_csv\\(.*encoding\\s*=",
    message: "pandas.read_csv 的 encoding 参数可能不存在于旧版本",
    severity: "medium",
    suggestion: "请确认 pandas 版本是否支持该参数",
    language: "python",
  },
  {
    pattern: "requests\\.get\\(.*verify\\s*=",
    message: "requests.get 的 verify 参数用法需确认",
    severity: "low",
    suggestion: "请确认 requests 库版本是否支持该参数",
    language: "python",
  },
  {
    pattern: "os\\.path\\.join\\([^)]*encoding\\s*=",
    message: "os.path.join 不接受 encoding 参数",
    severity: "high",
    suggestion: "使用 os.path.join(path1, path2)",
    language: "python",
  },
  {
    pattern: "requests\\.(?:post|get|put|delete|patch)\\([^)]*verify_cert\\s*=",
    message: "参数名应为 verify 而非 verify_cert",
    severity: "high",
    suggestion: "使用 requests.post(url, json=data, verify=True)",
    language: "python",
  },
  {
    pattern: "subprocess\\.run\\([^)]*text_mode\\s*=",
    message: "参数名应为 text 而非 text_mode",
    severity: "high",
    suggestion: "使用 subprocess.run(cmd, shell=True, capture_output=True, text=True)",
    language: "python",
  },
  {
    // 排除 json.loads(path.read_text(encoding="utf-8")) 等嵌套调用：
    // encoding 是 read_text/decode 的参数，不是 json.loads 的
    pattern: "json\\.loads\\((?!.*(?:read_text|read_text_async|decode)\\([^)]*\\)[^)]*?)[^)]*encoding\\s*=",
    message: "json.loads 在 Python 3.9+ 不接受 encoding 参数",
    severity: "high",
    suggestion: "使用 json.loads(string)",
    language: "python",
  },
  {
    pattern: "open\\([^)]*encoding[^)]*buffering\\s*=\\s*0",
    message: "文本模式下 buffering=0 无效，必须用二进制模式",
    severity: "high",
    suggestion: "使用 open(file, 'r', encoding='utf-8')",
    language: "python",
  },
  {
    pattern: "re\\.match\\([^)]*re\\.DOTALL",
    message: "re.match 不受 DOTALL 影响，应用 re.search",
    severity: "medium",
    suggestion: "使用 re.search(pattern, string, flags=re.IGNORECASE | re.DOTALL)",
    language: "python",
  },
  {
    pattern: "\\.merge\\(",
    message: "dict 没有 merge 方法，应使用 update() 或 {**d1, **d2}",
    severity: "high",
    suggestion: "使用 dict.update(other_dict) 或 {**dict1, **dict2}",
    language: "python",
  },
  {
    pattern: "\\.flatten\\(\\)",
    message: "list 没有 flatten 方法",
    severity: "high",
    suggestion: "使用 [item for sublist in nested for item in sublist]",
    language: "python",
  },
  {
    pattern: "\\.removeprefix\\([^)]*start\\s*=",
    message: "str.removeprefix 不接受 start 参数",
    severity: "high",
    suggestion: "使用 str.removeprefix(prefix)",
    language: "python",
  },
  {
    pattern: "iterrows\\(\\)\\.apply\\(",
    message: "iterrows() 返回迭代器，没有 apply 方法",
    severity: "high",
    suggestion: "使用 df.apply(func) 或 for idx, row in df.iterrows()",
    language: "python",
  },
  {
    pattern: "\\.tolist\\([^)]*dtype\\s*=",
    message: "tolist() 不接受 dtype 参数",
    severity: "high",
    suggestion: "使用 numpy.array.tolist()",
    language: "python",
  },
  {
    pattern: "asyncio\\.run\\([^)]*loop\\s*=",
    message: "asyncio.run 不接受 loop 参数",
    severity: "high",
    suggestion: "使用 asyncio.run(coro)",
    language: "python",
  },
  {
    pattern: "Path\\.mkdir\\([^)]*recursive\\s*=",
    message: "mkdir 不接受 recursive 参数，parents=True 已包含递归创建",
    severity: "high",
    suggestion: "使用 Path.mkdir(exist_ok=True, parents=True)",
    language: "python",
  },
  {
    pattern: "Optional\\[\\s*\\w+\\s*,\\s*\\w+\\s*\\]",
    message: "Optional 只接受一个类型参数，多类型应用 Union",
    severity: "high",
    suggestion: "使用 Optional[str] 或 Union[str, int, None]",
    language: "python",
  },
  {
    pattern: "@dataclass\\([^)]*slots\\s*=",
    message: "Python 3.9 的 dataclass 不支持 slots 参数（3.10+才支持）",
    severity: "medium",
    suggestion: "注意 Python 版本兼容性，slots 参数需要 Python 3.10+",
    language: "python",
  },
  // ===== 新增：AI 高频幻觉 API（Python） =====
  {
    pattern: "langchain\\.(?:LLM|Chain|Agent|Tool|Memory)\\.run\\(",
    message: "langchain 的 .run() 方法已废弃，应使用 .invoke()",
    severity: "high",
    suggestion: "使用 chain.invoke({input: ...}) 替代 chain.run(...)",
    language: "python",
  },
  {
    pattern: "langchain\\.llms\\.OpenAI\\(",
    message: "langchain.llms.OpenAI 已废弃，应使用 langchain_openai.ChatOpenAI",
    severity: "high",
    suggestion: "使用 from langchain_openai import ChatOpenAI; llm = ChatOpenAI()",
    language: "python",
  },
  {
    pattern: "langchain\\.chains\\.LLMChain\\(",
    message: "LLMChain 已废弃，应使用 RunnableSequence（pipe 语法）",
    severity: "high",
    suggestion: "使用 chain = prompt | llm | output_parser",
    language: "python",
  },
  {
    pattern: "torch\\.cuda\\.is_available\\(\\)\\.device\\(",
    message: "is_available() 返回 bool，没有 device 方法",
    severity: "high",
    suggestion: "使用 torch.device('cuda' if torch.cuda.is_available() else 'cpu')",
    language: "python",
  },
  {
    pattern: "np\\.array\\.flatten\\(\\s*axis\\s*=",
    message: "ndarray.flatten() 不接受 axis 参数",
    severity: "high",
    suggestion: "使用 np.ravel(a) 或 a.reshape(-1) 实现扁平化",
    language: "python",
  },
  {
    pattern: "cv2\\.imshow\\([^)]*block\\s*=",
    message: "cv2.imshow 不接受 block 参数，需用 cv2.waitKey() 控制阻塞",
    severity: "high",
    suggestion: "使用 cv2.imshow('win', img); cv2.waitKey(0)",
    language: "python",
  },
  {
    pattern: "sklearn\\.model_selection\\.train_test_split\\([^)]*random\\s*=",
    message: "参数名应为 random_state 而非 random",
    severity: "high",
    suggestion: "使用 train_test_split(X, y, random_state=42)",
    language: "python",
  },
  {
    pattern: "django\\.db\\.models\\.Model\\.objects\\.filter\\(\\s*\\)\\.get\\(\\s*\\)",
    message: "filter().get() 无参数会抛出 MultipleObjectsReturned 或 DoesNotExist",
    severity: "medium",
    suggestion: "使用 Model.objects.get(pk=id) 或 filter(condition).first()",
    language: "python",
  },
  {
    pattern: "fastapi\\.FastAPI\\.run\\(",
    message: "FastAPI 实例没有 run 方法，应使用 uvicorn 运行",
    severity: "high",
    suggestion: "使用 uvicorn.run(app, host='0.0.0.0', port=8000)",
    language: "python",
  },
  {
    pattern: "pytest\\.fixture\\([^)]*scope\\s*=\\s*['\"]function['\"]",
    message: "pytest fixture 的 scope 默认就是 function，无需显式指定",
    severity: "low",
    suggestion: "使用 @pytest.fixture 即可（默认 scope='function'）",
    language: "python",
  },
  {
    pattern: "logging\\.getLogger\\(\\)\\.setLevel\\(\\s*['\"]",
    message: "setLevel 不接受字符串，应使用 logging.DEBUG 等常量",
    severity: "high",
    suggestion: "使用 logger.setLevel(logging.DEBUG)",
    language: "python",
  },
  {
    pattern: "aiohttp\\.ClientSession\\(\\)\\.get\\([^)]*verify\\s*=",
    message: "aiohttp 的 SSL 验证参数是 ssl=False 而非 verify=False",
    severity: "high",
    suggestion: "使用 async with session.get(url, ssl=False) as resp:",
    language: "python",
  },
  {
    pattern: "subprocess\\.run\\([^)]*capture_output\\s*=\\s*False",
    message: "capture_output=False 是默认值，无需显式指定",
    severity: "low",
    suggestion: "如不需要捕获输出，省略 capture_output 参数即可",
    language: "python",
  },
];

// ==================== JavaScript/TypeScript 幻觉 API ====================
export const JS_TS_HALLUCINATION_APIS: HallucinatedAPI[] = [
  {
    pattern: "Array\\.fromAsync",
    message: "Array.fromAsync 是较新的API，可能不被所有环境支持",
    severity: "medium",
    suggestion: "请确认目标运行时是否支持 Array.fromAsync",
    language: "typescript",
  },
  {
    pattern: "fs\\.promises\\.readFile",
    message: "fs.promises API 需要确认Node.js版本支持",
    severity: "low",
    suggestion: "建议确认Node.js版本 >= 10",
    language: "typescript",
  },
  {
    pattern: "\\.flat\\(\\s*depth\\s*=\\s*Infinity\\s*\\)",
    message: "flat() 不接受 Infinity 作为默认参数，需显式传入",
    severity: "medium",
    suggestion: "使用 arr.flat(Infinity)",
    language: "typescript",
  },
  {
    pattern: "readFile\\([^)]*mode\\s*:",
    message: "readFile 不接受 mode 选项",
    severity: "high",
    suggestion: "使用 fs.promises.readFile(path, { encoding: 'utf-8' })",
    language: "typescript",
  },
  {
    pattern: "fetch\\([^)]*method\\s*:\\s*['\"]GET['\"][^}]*body\\s*:",
    message: "GET 请求不能有 body",
    severity: "high",
    suggestion: "使用 fetch(url, { method: 'POST', body: data })",
    language: "typescript",
  },
  {
    pattern: "\\.last\\(\\)",
    message: "Array 没有 last() 方法",
    severity: "high",
    suggestion: "使用 arr[arr.length - 1] 或 arr.at(-1)",
    language: "typescript",
  },
  {
    pattern: "Object\\.map\\(",
    message: "Object 没有 map 方法",
    severity: "high",
    suggestion: "使用 Object.entries(obj).map(...) 或 Object.keys(obj).map(...)",
    language: "typescript",
  },
  {
    pattern: "\\.reverse\\(\\)",
    message: "String 没有 reverse 方法",
    severity: "high",
    suggestion: "使用 str.split('').reverse().join('')",
    language: "typescript",
  },
  {
    pattern: "classList\\.contains\\([^)]+\\)\\.toggle\\(",
    message: "contains() 返回 boolean，没有 toggle 方法",
    severity: "high",
    suggestion: "使用 element.classList.toggle('hidden')",
    language: "typescript",
  },
  {
    pattern: "JSON\\.parse\\([^)]+\\)\\.stringify\\(\\)",
    message: "JSON.parse 返回对象，不是 JSON 对象本身",
    severity: "high",
    suggestion: "使用 const obj = JSON.parse(str); JSON.stringify(obj)",
    language: "typescript",
  },
  {
    pattern: "\\.unique\\(\\)",
    message: "Array 没有 unique 方法",
    severity: "high",
    suggestion: "使用 [...new Set(arr)]",
    language: "typescript",
  },
  {
    pattern: "console\\.log\\([^)]*\\)\\.flush\\(\\)",
    message: "console.log 没有 flush 方法",
    severity: "high",
    suggestion: "console.log 不需要 flush，直接使用 console.log(...args)",
    language: "typescript",
  },
  {
    pattern: "Map\\.prototype\\.map\\(",
    message: "Map 没有 map 方法",
    severity: "high",
    suggestion: "使用 Array.from(map.entries()).map(...) 或 for...of 遍历",
    language: "typescript",
  },
  {
    pattern: "setTimeout\\([^)]*unref\\s*=",
    message: "setTimeout 不接受 unref 参数，需在返回对象上调用",
    severity: "high",
    suggestion: "使用 const timer = setTimeout(fn, delay); timer.unref()",
    language: "typescript",
  },
  {
    pattern: "Buffer\\.from\\([^)]*strict\\s*=",
    message: "Buffer.from 不接受 strict 参数",
    severity: "high",
    suggestion: "使用 Buffer.from(str, 'utf-8')",
    language: "typescript",
  },
  {
    pattern: "process\\.env\\.set\\(",
    message: "process.env 不支持 set 方法",
    severity: "high",
    suggestion: "使用 process.env.KEY = 'value'",
    language: "typescript",
  },
  // ===== 新增：AI 高频幻觉 API（JS/TS） =====
  {
    pattern: "Array\\.prototype\\.first\\(\\)",
    message: "Array 没有 first() 方法",
    severity: "high",
    suggestion: "使用 arr[0] 或 arr.at(0)",
    language: "typescript",
  },
  {
    pattern: "Array\\.prototype\\.last\\(\\)",
    message: "Array 没有 last() 方法（TS 5.4+ 仅在特定条件下可用）",
    severity: "high",
    suggestion: "使用 arr[arr.length - 1] 或 arr.at(-1)",
    language: "typescript",
  },
  {
    pattern: "\\.groupBy\\(",
    message: "Array 没有 groupBy 方法（仍在 Stage 3 提案中）",
    severity: "high",
    suggestion: "使用 Object.groupBy(arr, fn)（ES2024+）或手写 reduce 实现",
    language: "typescript",
  },
  {
    pattern: "Object\\.deepCopy\\(",
    message: "Object 没有 deepCopy 方法",
    severity: "high",
    suggestion: "使用 structuredClone(obj) 或 JSON.parse(JSON.stringify(obj))",
    language: "typescript",
  },
  {
    pattern: "String\\.format\\(",
    message: "JS 的 String 没有 format 方法（Python 的写法）",
    severity: "high",
    suggestion: "使用模板字符串 `Hello ${name}` 或 str.replace('%s', name)",
    language: "typescript",
  },
  {
    pattern: "Array\\.range\\(",
    message: "Array 没有 range 静态方法",
    severity: "high",
    suggestion: "使用 Array.from({length: n}, (_, i) => i)",
    language: "typescript",
  },
  {
    pattern: "\\.pipe\\(\\s*\\)\\.subscribe\\(",
    message: "非 RxJS 的数组没有 pipe/subscribe 方法",
    severity: "high",
    suggestion: "确认是否使用了 RxJS；若非，使用数组的 map/filter 等方法",
    language: "typescript",
  },
  {
    pattern: "fs\\.promises\\.readFile\\([^)]*flag\\s*:\\s*['\"]w",
    message: "readFile 不应使用写模式 flag（w/a）",
    severity: "high",
    suggestion: "使用 fs.promises.writeFile(path, data, { flag: 'w' }) 写文件",
    language: "typescript",
  },
  {
    pattern: "Math\\.randomInt\\(",
    message: "Math 没有 randomInt 方法",
    severity: "high",
    suggestion: "使用 Math.floor(Math.random() * max) 或 crypto.getRandomValues()",
    language: "typescript",
  },
  {
    pattern: "Promise\\.allSettled\\(\\)\\.then\\([^)]*results\\.value\\b",
    message: "allSettled 返回 {status, value/reason}，需先检查 status",
    severity: "medium",
    suggestion: "使用 results.filter(r => r.status === 'fulfilled').map(r => r.value)",
    language: "typescript",
  },
];

// ==================== React 幻觉 API ====================
export const REACT_HALLUCINATION_APIS: HallucinatedAPI[] = [
  {
    pattern: "useEffect\\(\\s*async\\s",
    message: "useEffect 回调不能是 async 函数",
    severity: "high",
    suggestion: "使用 useEffect(() => { (async () => { ... })(); }, [deps])",
    language: "typescript",
  },
  {
    pattern: "useState\\([^)]*,\\s*key\\s*\\)",
    message: "useState 不接受 key 参数",
    severity: "high",
    suggestion: "使用 useState(initialState)",
    language: "typescript",
  },
  {
    pattern: "useMemo\\([^)]*,\\s*[^\\]]+\\]\\s*,\\s*\\w+\\s*\\)",
    message: "useMemo 不接受 compareFn 参数",
    severity: "high",
    suggestion: "使用 useMemo(callback, deps)",
    language: "typescript",
  },
  {
    pattern: "React\\.memo\\([^)]+\\)\\.defaultProps",
    message: "函数组件不支持 defaultProps（React 18.3+ 已废弃）",
    severity: "medium",
    suggestion: "使用默认参数值: function Comp({ prop = defaultValue }) {}",
    language: "typescript",
  },
  {
    pattern: "useRef\\([^)]*\\)\\.current\\.observe\\(",
    message: "useRef.current 不自动有 observe 方法",
    severity: "high",
    suggestion: "使用 useEffect + IntersectionObserver",
    language: "typescript",
  },
  // ===== 新增：React/Next.js 高频幻觉 API =====
  {
    pattern: "useEffect\\([^)]*return\\s+undefined",
    message: "useEffect cleanup 函数不应返回 undefined",
    severity: "medium",
    suggestion: "返回一个清理函数或什么都不返回",
    language: "typescript",
  },
  {
    pattern: "useState\\(\\s*\\)\\.setState\\(",
    message: "useState 返回的 setter 名称不是 setState，是自定义命名",
    severity: "high",
    suggestion: "使用 const [value, setValue] = useState()",
    language: "typescript",
  },
  {
    pattern: "useEffect\\(\\s*\\[\\s*\\]\\s*,\\s*callback\\s*\\)",
    message: "useEffect 的依赖数组应在回调之后，不是之前",
    severity: "high",
    suggestion: "使用 useEffect(callback, [deps])",
    language: "typescript",
  },
  {
    pattern: "next/router\\.(?:useRouter|Router)\\s*\\{\\s*pathname",
    message: "Next.js App Router 中 useRouter 不返回 pathname，应使用 usePathname",
    severity: "high",
    suggestion: "使用 import { usePathname } from 'next/navigation'",
    language: "typescript",
  },
  {
    pattern: "useRouter\\(\\)\\.push\\([^)]*\\)\\.(?:then|catch)\\(",
    message: "Next.js useRouter().push() 不返回 Promise",
    severity: "high",
    suggestion: "router.push() 是 void 返回值，不能 .then/.catch",
    language: "typescript",
  },
  {
    pattern: "getServerSideProps\\s*=\\s*async\\s*\\(\\s*\\)",
    message: "Next.js App Router 不支持 getServerSideProps（Pages Router 特有）",
    severity: "high",
    suggestion: "在 App Router 中使用 async Server Component 直接 fetch 数据",
    language: "typescript",
  },
];

// ==================== Go 幻觉 API ====================
export const GO_HALLUCINATION_APIS: HallucinatedAPI[] = [
  {
    pattern: "os\\.ReadFile",
    message: "os.ReadFile 需要 Go 1.16+",
    severity: "medium",
    suggestion: "请确认Go版本 >= 1.16，或使用 ioutil.ReadFile",
    language: "go",
  },
  {
    pattern: "context\\.withTimeout",
    message: "正确拼写为 context.WithTimeout（大写 W），AI 常生成小写 withTimeout",
    severity: "high",
    suggestion: "使用 context.WithTimeout(parent, timeout)",
    language: "go",
  },
  {
    pattern: "http\\.NewRequestWithContext\\([^)]*,\\s*[^)]*,\\s*[^)]*,\\s*[^)]*,\\s*[^)]+\\)",
    message: "http.NewRequestWithContext 不接受 headers 参数",
    severity: "high",
    suggestion: "使用 req := http.NewRequestWithContext(ctx, method, url, body); req.Header.Set(...)",
    language: "go",
  },
  {
    pattern: "strings\\.ContainsAny\\([^)]*caseInsensitive\\s*=",
    message: "strings.ContainsAny 不接受 caseInsensitive 参数",
    severity: "high",
    suggestion: "使用 strings.Contains(strings.ToLower(s), strings.ToLower(substr))",
    language: "go",
  },
  {
    pattern: "fmt\\.Sprintf\\([^)]+\\)\\.Print\\(\\)",
    message: "Sprintf 返回字符串，没有 Print 方法",
    severity: "high",
    suggestion: "使用 fmt.Sprintf(format, args...) 返回字符串，用 fmt.Print() 打印",
    language: "go",
  },
  {
    pattern: "\\.Read\\(\\s*\\w+\\s*,\\s*\\w+\\s*\\)",
    message: "os.File.Read 不接受 offset 参数",
    severity: "high",
    suggestion: "使用 os.File.ReadAt(buf, offset) 或 os.File.Seek + Read",
    language: "go",
  },
  // ===== 新增：Go 高频幻觉 API =====
  {
    pattern: "slog\\.(?:Info|Error|Warn|Debug)\\([^)]*(?:name|msg)\\s*=",
    message: "slog 的参数名是 msg 不是 name/message",
    severity: "high",
    suggestion: "使用 slog.Info(\"msg\", \"key\", value)",
    language: "go",
  },
  {
    pattern: "context\\.Background\\(\\)\\.WithValue\\(",
    message: "context.Background() 返回的 ctx 不应直接链式调用 WithValue",
    severity: "medium",
    suggestion: "使用 ctx := context.Background(); ctx = context.WithValue(ctx, key, val)",
    language: "go",
  },
  {
    pattern: "http\\.ListenAndServe\\([^)]*handler\\s*=",
    message: "http.ListenAndServe 不接受 handler 关键字参数（Go 无关键字参数）",
    severity: "high",
    suggestion: "使用 http.ListenAndServe(addr, handler)",
    language: "go",
  },
  {
    pattern: "json\\.Marshal\\([^)]*indent\\s*=",
    message: "json.Marshal 不接受 indent 参数，应使用 json.MarshalIndent",
    severity: "high",
    suggestion: "使用 json.MarshalIndent(data, \"\", \"  \")",
    language: "go",
  },
  {
    pattern: "errors\\.New\\(\\s*fmt\\.Sprintf\\(",
    message: "errors.New(fmt.Sprintf(...)) 应简化为 fmt.Errorf(...)",
    severity: "low",
    suggestion: "使用 fmt.Errorf(\"message: %v\", err) 或 errors.New(\"static message\")",
    language: "go",
  },
  {
    pattern: "sync\\.Mutex\\.TryLock\\(\\)\\s*&&",
    message: "TryLock 在 Go 1.18+ 才可用，且返回 bool 不应与其他条件短路",
    severity: "medium",
    suggestion: "使用 if mu.TryLock() { ... mu.Unlock() }",
    language: "go",
  },
];

// ==================== Java 幻觉 API ====================
export const JAVA_HALLUCINATION_APIS: HallucinatedAPI[] = [
  {
    pattern: "\\.isEmptyOrNull\\(\\)",
    message: "String 没有 isEmptyOrNull 方法",
    severity: "high",
    suggestion: "使用 str == null || str.isEmpty()",
    language: "java",
  },
  {
    pattern: "List\\.of\\([^)]*\\)\\.add\\(",
    message: "List.of 返回不可变列表，不支持 add",
    severity: "high",
    suggestion: "使用 new ArrayList<>(List.of(elements))",
    language: "java",
  },
  {
    pattern: "\\.get\\(\\)\\.orElse\\(",
    message: "get() 和 orElse 不应链式调用，get() 可能抛异常",
    severity: "high",
    suggestion: "使用 optional.orElse(defaultValue)",
    language: "java",
  },
  {
    pattern: "\\.toList\\(\\)\\.add\\(",
    message: "Stream.toList() 返回不可变列表",
    severity: "high",
    suggestion: "使用 new ArrayList<>(stream.toList())",
    language: "java",
  },
  {
    pattern: "\\.getOrDefault\\([^)]*,\\s*\\(\\)\\s*->",
    message: "getOrDefault 不接受 Supplier，会立即计算默认值",
    severity: "high",
    suggestion: "使用 map.computeIfAbsent(key, k -> computeDefault())",
    language: "java",
  },
];

// ==================== Rust 幻觉 API ====================
export const RUST_HALLUCINATION_APIS: HallucinatedAPI[] = [
  {
    pattern: "Vec::new\\(\\s*\\w+\\s*\\)",
    message: "Vec::new 不接受 capacity 参数",
    severity: "high",
    suggestion: "使用 Vec::with_capacity(capacity)",
    language: "rust",
  },
  {
    pattern: "from_utf8\\([^)]*\\)\\.unwrap_or_default\\(\\)",
    message: "from_utf8 返回 Result，unwrap_or_default 对 String 返回空字符串可能非预期",
    severity: "medium",
    suggestion: "使用 String::from_utf8(bytes).unwrap_or_else(|_| String::from_utf8_lossy(&bytes).into_owned())",
    language: "rust",
  },
  {
    pattern: "unwrap_or_default\\(\\s*\\w+",
    message: "unwrap_or_default 不接受参数",
    severity: "high",
    suggestion: "使用 option.unwrap_or(value) 或 option.unwrap_or_default()",
    language: "rust",
  },
  {
    pattern: "\\.get\\(\\s*\\w+\\s*\\)\\.insert\\(",
    message: "get 返回 Option，没有 insert 方法",
    severity: "high",
    suggestion: "使用 map.insert(key, value)",
    language: "rust",
  },
  {
    pattern: "\\.map\\([^)]+\\)\\.collect::<Vec<_>>\\(\\)\\.filter\\(",
    message: "filter 应在 collect 之前调用，否则先收集再过滤效率低",
    severity: "medium",
    suggestion: "使用 iter.map(closure).filter(predicate).collect::<Vec<_>>()",
    language: "rust",
  },
  // ===== 新增：Rust 高频幻觉 API =====
  {
    pattern: "tokio::spawn\\(\\)\\.await\\?;",
    message: "tokio::spawn 返回 JoinHandle，JoinHandle.await 返回 Result<Result<T>>，需双层解包",
    severity: "high",
    suggestion: "使用 let result = tokio::spawn(async { ... }).await??? 或 .await?.unwrap()",
    language: "rust",
  },
  {
    pattern: "Arc::new\\(\\s*Mutex::new\\(\\s*\\)\\.lock\\(\\)\\.await",
    message: "std::sync::Mutex::lock() 不返回 Future，不能 .await（应使用 tokio::sync::Mutex）",
    severity: "high",
    suggestion: "使用 Arc::new(tokio::sync::Mutex::new(value)); let guard = lock.lock().await;",
    language: "rust",
  },
  {
    pattern: "String::from_utf8\\([^)]*\\)\\.expect\\([^)]*\\)\\.to_string\\(\\)",
    message: "from_utf8 返回的 String 已有 to_string，重复调用无意义",
    severity: "medium",
    suggestion: "使用 String::from_utf8(bytes).expect(\"msg\")",
    language: "rust",
  },
  {
    pattern: "println!\\([^)]*\\{:\\?\\}",
    message: "println! 的 Debug 格式化 {:?} 可能泄露内部结构，生产代码应考虑 Display",
    severity: "low",
    suggestion: "考虑实现 Display trait 并使用 {} 格式化",
    language: "rust",
  },
  {
    pattern: "Vec::new\\(\\)\\.push\\(",
    message: "Vec::new() 返回空 Vec，链式 push 不会返回 Vec",
    severity: "high",
    suggestion: "使用 let mut v = Vec::new(); v.push(item); 或 vec![item]",
    language: "rust",
  },
  {
    pattern: "HashMap::new\\(\\)\\.insert\\(",
    message: "HashMap::new() 返回空 Map，链式 insert 不会返回 Map",
    severity: "high",
    suggestion: "使用 let mut m = HashMap::new(); m.insert(k, v);",
    language: "rust",
  },
];

/**
 * 获取所有幻觉 API 规则
 */
export function getAllHallucinationAPIs(): HallucinatedAPI[] {
  return [
    ...PYTHON_HALLUCINATION_APIS,
    ...JS_TS_HALLUCINATION_APIS,
    ...REACT_HALLUCINATION_APIS,
    ...GO_HALLUCINATION_APIS,
    ...JAVA_HALLUCINATION_APIS,
    ...RUST_HALLUCINATION_APIS,
  ];
}

/**
 * 按语言获取幻觉 API 规则
 */
export function getHallucinationAPIsByLanguage(language: string): HallucinatedAPI[] {
  const all = getAllHallucinationAPIs();
  if (language === "javascript") {
    return all.filter(api => api.language === "typescript");
  }
  return all.filter(api => api.language === language);
}
