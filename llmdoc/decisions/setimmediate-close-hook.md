# close 钩子用 setImmediate 延迟落账

`res.on('close')` 内用 `setImmediate` 包住 `recordOutcome`，不要同步调用。

**Why:** `res.end()` 在 `forwardOnce` 内部触发的 `close` 事件经 nextTick 派发，**先于** `await forwardOnce` 的 promise 微任务恢复——而 `reqCtx.usage`/`reqCtx.bytes` 是在那个微任务恢复后才赋值的。实测同步记账导致 `/metrics` 里 `yescode_tokens_total` 和 `yescode_bytes_total` 整段丢失。`setImmediate` 把记账推到事件循环 check 阶段，那时 `reqCtx` 已填满。被否决方案：在 success 分支内联记账——会漏掉非成功退出（错误、客户端中断）的请求。

**How to apply:** 任何依赖 `reqCtx` 终态字段（usage/bytes）的逻辑，都要等到 close 之后的 `setImmediate` 里读。
