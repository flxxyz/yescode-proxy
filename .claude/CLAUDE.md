> Detailed contracts, configs, and runbooks live in `/llmdoc/`.

<always-step-one>
read the README and follow `llmdoc-structure` to read the related docs

IMPORTANT: You must read the documentation thoroughly, at least three relevant documents.
</always-step-one>

<llmdoc-structure>
- /llmdoc/index.md: Index of the docs — read first.
- /llmdoc/architecture/: How each mechanism works (hot-reload, routing & protocol translation, the auth gate, metrics) — the "LLM Retrieval Map". Answers "How does it work?".
- /llmdoc/reference/: Factual lookup — config parameters (env vars, keys.json fields), endpoints, metric names. Answers "What are the specifics of X?".
- /llmdoc/decisions/: Why it's built this way — design decisions, rejected alternatives, hidden constraints not derivable from code. Maintained by the `recorder` agent.

README.md / README.en.md stay as overview + quick-start; deep config/field detail lives in reference/.
</llmdoc-structure>

## 核心工作原则

- **Document-Driven Development**：始终优先阅读相关的 llmdoc，结合文档和实际代码文件来确定修改方案，文档结构参考 `llmdoc-structure`。
- **维护 llmdoc**：后一个 TODO 永远是「使用 docer agent 更新项目文档系统」。
- **后台执行**：对于可以准确描述执行路径的任务（如一系列 Bash 命令、简单脚本编写、代码修改、单元测试等），优先使用 bg-worker agent。
- **沉淀设计决策**：从代码读不出来的设计背景、踩过的坑、被否定的备选方案，用 `recorder` agent 写入 `llmdoc/decisions/`。
- **始终遵循规则**：`always-step-one`。
