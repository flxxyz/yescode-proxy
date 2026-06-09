# keys.json 参考

虚拟 SK 白名单文件。路径由 `YESCODE_KEYS_FILE` 环境变量决定，默认为工作目录下的 `keys.json`。文件含明文密钥，已加入 `.gitignore`。

## 格式

支持两种顶层结构：

**对象包裹**（推荐）：

```json
{
  "keys": [
    { "key": "sk-yc-alice-9f3k2m", "label": "alice", "enabled": true, "expires": "2026-12-31T00:00:00Z" },
    { "key": "sk-yc-bob-x82mqp", "label": "bob", "enabled": true }
  ]
}
```

**裸数组**：

```json
[
  { "key": "sk-yc-alice-9f3k2m", "label": "alice" }
]
```

## 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `key` | string | 是 | -- | 虚拟 SK 明文。推荐使用 `sk-yc-` 前缀。 |
| `label` | string | 否 | `maskMetricKey(key)` | 人类可读标签，用于日志。指标 label 始终使用脱敏后的 key，不用 label。 |
| `enabled` | boolean | 否 | `true` | 设为 `false` 可停用该 key 而不删除条目。 |
| `expires` | string | 否 | 无（永不过期） | ISO 8601 格式的过期时间。过期后 `authorizeVirtualKey` 拒绝该 key，reason 为 `expired`。 |

## fail-open 语义

- 文件不存在 -> 空 Map -> 鉴权关闭，所有请求放行。
- 文件为空或 `{ "keys": [] }` -> 同上。
- 文件存在且至少一条有效 key -> 鉴权启用，必须提供白名单中的 key 才能通过。

启动日志会打印当前状态：`virtual-key auth: disabled (fail-open)` 或 `virtual-key auth: N key(s) from <path>`。

## 热重载

文件变更由 `watchFile` 检测（1 秒轮询 + 200 毫秒防抖），SIGHUP 也触发 reload。reload 时：

- 新文件解析成功 -> 原子替换 `virtualKeys`。
- JSON 解析失败 -> **保留旧白名单**（fail-safe），不会因手误把鉴权降为 fail-open。
- 文件被删除 -> 空 Map -> fail-open。

详见 [../architecture/hot-reload.md](../architecture/hot-reload.md)。
