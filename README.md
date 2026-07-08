# AIDE - AI Coding Quality Inspector

> Detect hallucinations, stub code, security issues, and errors in AI-generated code — zero config, zero LLM cost by default.

## Features

- **12 detectors** covering AI-generated code pitfalls: package hallucination, API hallucination, stub functions, empty implementations, hardcoded values, fake URLs, swallowed errors, unhandled promises, unused declarations, unreachable code, resource leaks, and security issues
- **10 languages**: TypeScript, JavaScript, Python, Go, Java, Rust, Ruby, PHP, C/C++, C#, Swift, Kotlin
- **Pure local scan** — `aide scan` runs entirely offline, 0 token consumption
- **LLM-assisted review** — `aide scan-llm` uses an independent LLM to reduce false positives (40-60% pre-filtered locally before LLM calls)
- **Configurable** — `.aiderc.json` project config, CLI flags override, strict mode, confidence filtering
- **CI-friendly** — `--exit-code` flag, JSON/supervisor output formats, `--offline` mode

## Install

```bash
npm install -g @aide-dev/aide
```

Requires Node.js >= 20.

## Quick Start

```bash
# Scan your project (pure local, no LLM needed)
aide scan

# Strict mode: only high + medium severity
aide scan --strict

# LLM-assisted scan (reduces false positives)
aide scan-llm --model gpt-4o

# Configure LLM provider
aide configure-llm

# JSON output for CI integration
aide scan --format json --exit-code
```

## Commands

| Command | Description |
|---------|-------------|
| `aide scan` | Pure local scan, 0 token cost |
| `aide scan-llm` | LLM-assisted scan for lower false positive rate |
| `aide configure-llm` | Configure LLM provider (OpenAI, Anthropic, etc.) |

### Common Options

```
--strict              Only report high + medium severity
--skip <rules>        Disable specific detectors
--only <rules>        Only run specific detectors
--format <fmt>        Output: default, verbose, ai, json, supervisor
--offline             Disable network requests
--exit-code           Exit with code 1 if issues found (CI mode)
--min-confidence <lv> Minimum confidence: high, medium, low
```

## Detectors

| Detector | What it catches |
|----------|----------------|
| `package-hallucination` | Imports of non-existent npm/PyPI/Go/Java packages |
| `api-hallucination` | Calls to non-existent stdlib/module APIs |
| `stub-function` | Functions returning only `true`/`false`/`null`/`0`/`{}`/`[]` |
| `empty-impl` | Empty function/class method bodies |
| `hardcoded-value` | Hardcoded URLs, IPs, ports, paths |
| `fake-url` | Placeholder/example URLs in production code |
| `swallowed-error` | catch/except blocks with no error handling |
| `unhandled-promise` | Floating promises, missing `.catch()` |
| `unused-declaration` | Unused variables and imports |
| `unreachable-code` | Code after return/throw/break |
| `resource-leak` | Unclosed files, connections, streams |
| `security` | Hardcoded secrets, SQL injection, XSS, command injection |

## Configuration

Create `.aiderc.json` in your project root:

```json
{
  "skipRules": ["narrative-comments"],
  "strict": true,
  "ignore": ["vendor"],
  "format": "supervisor",
  "minConfidence": "medium"
}
```

Priority: CLI flags > `.aiderc.json` > defaults.

## How It Works

```
Source files → Local detectors (regex + AST + registry)
                → isInNonCode filter (skip strings/comments/regex)
                → Local prefilter (13 rules, 0 token)
                → [Optional] LLM review (rule-customized context)
                → Severity + confidence filtering
                → Results
```

## Development

```bash
git clone https://github.com/ldkong2077/aide.git
cd aide
npm install
npm run build
npm test
```

## License

MIT
