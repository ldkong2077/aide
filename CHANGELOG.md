# Changelog

## v2.0.0 (2026-07-08)

### 🚀 Production Release

Initial production-ready release of AIDE - AI Coding Quality Inspector.

### Features

- **14 stable detectors**: package-hallucination, api-hallucination, stub-function, empty-impl, hardcoded-value, fake-url, swallowed-error, unhandled-promise, unused-declaration, unreachable-code, resource-leak, security, weak-validation, structure
- **2 preview detectors**: narrative-comments, dead-code
- **13 languages**: Python, TypeScript, JavaScript, Go, Java, Rust, Ruby, PHP, C, C++, C#, Swift, Kotlin
- Pure local scan with zero token cost
- Optional LLM-assisted false positive reduction
- `--strict` mode (high/medium severity only)
- `--auto` mode (auto-enable reduce-fp if LLM configured)
- CI-friendly: `--exit-code`, JSON/supervisor output, `--offline` mode
- Configurable via `.aiderc.json` or CLI flags

### Architecture

- 4-layer false positive control: detector regex/exemptions → isInNonCode filter → local prefilter (13 rules) → LLM review
- Rule-customized LLM context for efficient token usage
- Caching with line-number-based keys to prevent collisions

### Quality

- TypeScript strict mode, full type coverage
- 30 unit tests across core modules and detectors
- Self-scan: 0 real issues detected
- Real project validation: 40-84% false positive reduction
