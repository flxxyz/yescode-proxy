# 指标标签基数保护：拒绝类指标不带 key

`yescode_rejects_total` 只带 `reason` label；所有 per-key 指标的 `vkey` 一律是 `maskMetricKey` 脱敏后的白名单值或 `(none)`，绝不使用客户端提交的原始 key。

**Why:** 被拒请求的 key 由调用方、攻击者任意构造，若进 label 会导致基数爆炸打爆 Prometheus。

**How to apply:** 新增任何带 key 维度的指标时，label 只能用脱敏后的白名单 vkey；拒绝/异常类指标按固定枚举（如 reason）分类，不要带无界字段。
