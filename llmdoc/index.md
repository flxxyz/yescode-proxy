# llmdoc 索引

yescode-proxy 的内部设计文档。面向 LLM agent 和维护者，描述代理的运行机制和参考信息。

## Architecture

系统是怎么运转的。

- [hot-reload.md](architecture/hot-reload.md) -- `.env` 与 `keys.json` 的热重载机制
- [routing-and-translation.md](architecture/routing-and-translation.md) -- 多上游路由与 `/v1/chat/completions` 双向协议翻译
- [auth-gate.md](architecture/auth-gate.md) -- 虚拟 SK 白名单鉴权与凭证注入
- [metrics.md](architecture/metrics.md) -- Prometheus `/metrics` 端点与按 key 用量归因

## Reference

事实查表。

- [config.md](reference/config.md) -- 完整环境变量参考（`YESCODE_*`）
- [keys-json.md](reference/keys-json.md) -- `keys.json` schema 与 fail-open 语义
- [endpoints-and-metrics.md](reference/endpoints-and-metrics.md) -- 路由表、model 前缀、指标名清单

## Decisions

设计决策与踩坑记录。由 recorder agent 维护。

- [虚拟 SK 边缘鉴权采用 fail-open](decisions/fail-open-auth.md) -- `keys.json` 缺失或为空时放行所有请求，让虚拟 SK 成为可选 opt-in
- [虚拟 SK 门是纯附加层，位于凭证强制覆盖之前](decisions/auth-gate-before-credential-injection.md) -- 鉴权作为前置准入门，与凭证注入解耦；401 先于 404 防路径探测
- [close 钩子用 setImmediate 延迟落账](decisions/setimmediate-close-hook.md) -- 同步记账会因事件循环时序导致 token/bytes 指标丢失
- [指标标签基数保护：拒绝类指标不带 key](decisions/reject-metrics-no-key-label.md) -- 被拒请求的 key 由调用方任意构造，进 label 会导致基数爆炸
