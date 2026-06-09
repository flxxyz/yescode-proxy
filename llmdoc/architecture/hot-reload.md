# 热重载

进程运行期间修改 `.env` 或 `keys.json` 可在不重启的情况下生效。正在处理的请求和 SSE 流不受影响。

## 触发方式

1. **SIGHUP** -- `systemctl --user reload yescode-proxy` 或 `kill -HUP <pid>`。处理器在 `process.on('SIGHUP', ...)` 中同时调用 `applyReload('SIGHUP')` 和 `applyKeysReload('SIGHUP')`。
2. **fs.watchFile** -- 分别对 `ENV_FILE_PATH` 和 `KEYS_FILE_PATH` 各注册一个 `watchFile`（轮询间隔 1 秒）。检测到 `mtime` 变化后经过约 200 毫秒防抖再执行实际的 reload。

两处 `watchFile` 注册位于文件末尾（分别监视 `.env` 和 `keys.json`），使用 `{ interval: 1000 }` 轮询。

## .env 热重载流程

1. `scheduleReload(reason)` -- 200 毫秒防抖定时器（`reloadTimer`），防止编辑器快速连续保存触发多次 reload。
2. `applyReload(reason)`:
   - 调用 `loadEnvFile(ENV_FILE_PATH)` 重新解析 `.env` 写入 `process.env`。
   - 调用 `loadConfig()` 从 `process.env` 构建新的冻结配置对象（`Object.freeze`）。
   - 通过 `diffConfig(config, next)` 比较新旧配置，打印变更的字段（API key 经 `maskAuthValue` 遮蔽后输出）。
   - 原子替换：`config = next`，一次性替换整个引用，不原地修改。

### fail-safe

`loadEnvFile` 或 `loadConfig()` 抛异常时，reload 中止、保留旧 `config`，打印错误日志。半写状态的 `.env` 不会产生半填充的配置。

### 重启才生效的字段

`PORT` 和 `BIND` 在启动时绑定到监听 socket（`BOOT_PORT`、`BOOT_BIND`），热重载只会打印警告并忽略变更。

### 跨重载保持稳定的字段

为避免设备指纹变动，以下字段在对应环境变量为空时保持启动时的值：

- `YESCODE_REMOTE_CONTAINER_ID`、`YESCODE_REMOTE_SESSION_ID` -- 启动时随机生成 UUID，存入 `BOOT_CONTAINER_ID`、`BOOT_SESSION_ID`，reload 时若 env 为空则沿用。
- `deviceId` -- `createHash('sha256').update('claude_user_' + deviceSeed).digest('hex')`，`deviceSeed` 默认 `"yescode-proxy-default"`。

## keys.json 热重载流程

1. `scheduleKeysReload(reason)` -- 同样 200 毫秒防抖（`keysReloadTimer`）。
2. `applyKeysReload(reason)`:
   - 调用 `loadKeysFile(KEYS_FILE_PATH)` 解析出新的 `Map`。
   - 原子替换：`virtualKeys = next`。
   - 打印变更摘要（如 `3 → 2 key(s)` 或 `disabled (fail-open)`）。

### fail-safe

`loadKeysFile` 抛异常（如 JSON 语法错误）时，保留旧 `virtualKeys`，不会因一个手误把鉴权降级为 fail-open。

## 关键函数 / 变量

| 标识符 | 位置 | 职责 |
|---|---|---|
| `loadEnvFile(path)` | 模块顶部 | 最小 `.env` 解析器，写入 `process.env` |
| `loadConfig()` | 模块顶部 | 从 `process.env` 构建冻结配置对象 |
| `scheduleReload(reason)` | 模块顶部 | 200ms 防抖后调 `applyReload` |
| `applyReload(reason)` | 模块顶部 | 执行 `.env` reload 全流程 |
| `diffConfig(prev, next)` | 模块顶部 | 比较两个配置对象并返回变更的 key 列表 |
| `scheduleKeysReload(reason)` | virtual SK 段 | 200ms 防抖后调 `applyKeysReload` |
| `applyKeysReload(reason)` | virtual SK 段 | 执行 keys.json reload 全流程 |
| `BOOT_PORT` / `BOOT_BIND` | 模块顶部常量 | 启动时冻结的监听地址，reload 无法改变 |
| `BOOT_CONTAINER_ID` / `BOOT_SESSION_ID` | 模块顶部常量 | 启动时冻结的 UUID |
