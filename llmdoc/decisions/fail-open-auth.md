# 虚拟 SK 边缘鉴权采用 fail-open

`keys.json` 缺失或为空时放行所有请求（等于鉴权关闭）。

**Why:** 代理上线前边缘是零鉴权的；若默认 fail-closed，部署那一刻就会把所有现有客户端全挡死。fail-open 让虚拟 SK 成为可选 opt-in。

**How to apply:** 放一个非空 `keys.json` 即启用白名单；`authorizeVirtualKey` 在 `virtualKeys.size === 0` 时直接返回放行。
