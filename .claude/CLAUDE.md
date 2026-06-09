> Detailed contracts, configs, and runbooks live in `/llmdoc/`.

<always-step-one>
follow `llmdoc-structure` and read related documents

IMPORTANT: You must read the documentation thoroughly, at least more than three documents.
</always-step-one>

<llmdoc-structure>
- /llmdoc/index.md: The main index document. Always read this first.
- /llmdoc/overview/: For high-level project context. Answers "What is this project?". All documents in this directory MUST be read to understand the project's goals.
- /llmdoc/guides/: For step-by-step operational instructions. Answers "How do I do X?".
- /llmdoc/architecture/: For how the system is built (the "LLM Retrieval Map"). Answers "How does it work?".
- /llmdoc/reference/: For detailed, factual lookup information (e.g., API specs, data models, conventions). Answers "What are the specifics of X?".
- /llmdoc/decisions/: For design decisions / hidden constraints that can't be derived from code. Maintained by the `recorder` agent.
</llmdoc-structure>

## 核心工作原则

- **Document-Driven Development**：始终优先阅读相关的 llmdoc，结合文档和实际代码文件来确定修改方案，文档结构参考 `llmdoc-structure`。
- **维护 llmdoc**：后一个 TODO 永远是「使用 docer agent 更新项目文档系统」。
- **后台执行**：对于可以准确描述执行路径的任务（如一系列 Bash 命令、简单脚本编写、代码修改、单元测试等），优先使用 bg-worker agent。
- **沉淀设计决策**：从代码读不出来的设计背景、踩过的坑、被否定的备选方案，用 `recorder` agent 写入 `llmdoc/decisions/`。
- **始终遵循规则**：`always-step-one`。


