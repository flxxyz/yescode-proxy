import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, watchFile } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// Boot-time bindings — server.listen() uses these once and cannot be
// rebound without dropping the listening socket. Tracked separately so
// reload can warn-and-ignore attempts to change them.
const BOOT_PORT = Number.parseInt(process.env.PORT ?? '18790', 10);
const BOOT_BIND = process.env.BIND ?? '127.0.0.1';
const ENV_FILE_PATH = process.env.YESCODE_ENV_FILE
  ?? resolvePath(process.cwd(), '.env');
// Client-facing virtual-SK allowlist (edge auth). Same override + default-in-cwd
// convention as the env file, hot-reloaded the same way. An absent file means
// "no allowlist" → fail-open (every request passes), so the proxy stays
// backward-compatible until you opt in by creating keys.json.
const KEYS_FILE_PATH = process.env.YESCODE_KEYS_FILE
  ?? resolvePath(process.cwd(), 'keys.json');

// Stable across reloads — re-rolling these on every reload would shuffle
// the device fingerprint we send to yescode, which is the opposite of
// what reload-without-restart is for.
const BOOT_CONTAINER_ID = process.env.YESCODE_REMOTE_CONTAINER_ID || randomUUID();
const BOOT_SESSION_ID = process.env.YESCODE_REMOTE_SESSION_ID || randomUUID();

const stainlessOS = (() => {
  const p = process.platform;
  if (p === 'linux') return 'Linux';
  if (p === 'darwin') return 'MacOS';
  if (p === 'win32') return 'Windows';
  if (p === 'freebsd') return 'FreeBSD';
  if (p === 'openbsd') return 'OpenBSD';
  return p ? `Other:${p}` : 'Unknown';
})();
const stainlessArch = (() => {
  const a = process.arch;
  if (a === 'x64' || a === 'x86_64') return 'x64';
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  if (a === 'arm') return 'arm';
  if (a === 'x32') return 'x32';
  return a ? `other:${a}` : 'unknown';
})();

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

const LEGACY_USER_ID_PATTERN = /^user_[0-9a-f]{64}_account__session_[A-Za-z0-9-]+$/;

function maskAuthValue(value) {
  const s = String(value ?? '');
  if (s.length <= 12) return s.replace(/./g, '*');
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

// Virtual-SK label for metrics. Keeps the `sk-yc-` prefix, then first-4 + four
// fixed 'x' + last-4 of the body (a too-short body collapses to just the mask).
// e.g. sk-yc-alice-9f3k2m → sk-yc-alicxxxx3k2m. Only ever applied to keys drawn
// from the allowlist — never to a client-supplied value — so the set of distinct
// labels in /metrics is bounded by the allowlist size, not by traffic.
const VKEY_PREFIX = 'sk-yc-';
const VKEY_MASK = 'xxxx';
function maskMetricKey(sk) {
  const s = String(sk ?? '');
  if (!s) return '(none)';
  const hasPrefix = s.startsWith(VKEY_PREFIX);
  const prefix = hasPrefix ? VKEY_PREFIX : '';
  const body = hasPrefix ? s.slice(VKEY_PREFIX.length) : s;
  if (body.length <= 8) return prefix + VKEY_MASK;   // too short: first-4/last-4 would overlap
  return prefix + body.slice(0, 4) + VKEY_MASK + body.slice(-4);
}

function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

function timestamp() {
  return new Date().toISOString();
}

// Minimal `.env` parser. Only supports `KEY=VALUE`, `#` comments, blank
// lines, and surrounding `"` / `'` quotes. No interpolation, no multiline.
// Mutates process.env in place — keys absent from the file are left alone,
// so commenting a line out won't unset its env var (set `KEY=` for that).
function loadEnvFile(path) {
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2
      && ((value[0] === '"' && value[value.length - 1] === '"')
        || (value[0] === "'" && value[value.length - 1] === "'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadConfig() {
  const upstreamTimeoutMs = Number.parseInt(process.env.YESCODE_TIMEOUT_MS ?? '30000', 10);
  const claudeCliVersion = process.env.YESCODE_CLAUDE_CLI_VERSION ?? '2.1.75';
  const claudeCliEntrypoint = process.env.YESCODE_CLAUDE_CLI_ENTRYPOINT ?? 'cli';
  const codexCliVersion = process.env.YESCODE_CODEX_CLI_VERSION ?? '0.137.0';
  const stainlessPackageVersion = process.env.YESCODE_STAINLESS_VERSION ?? '0.74.0';
  const deviceSeed = process.env.YESCODE_DEVICE_SEED ?? 'yescode-proxy-default';

  // Upstream statuses that mean "this key won't work" — trigger a retry with the
  // next credential in the chain. Stored as a sorted array (not a Set) so diffConfig
  // can compare it by key without an empty-Set false-negative on reload.
  const keyFallbackStatuses = Array.from(new Set(
    (process.env.YESCODE_KEY_FALLBACK_STATUSES ?? '401,403')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599),
  )).sort((a, b) => a - b);

  // Upstream statuses that mean "transient, try again" — the proxy retries the
  // same request (same key) on the primary's backoff schedule before giving up,
  // mirroring what the Anthropic/OpenAI SDKs do client-side. Default 429/503/529
  // (rate-limited, "no capacity available", overloaded). Distinct from
  // keyFallbackStatuses: those switch credential, these just retry.
  const retryStatuses = Array.from(new Set(
    (process.env.YESCODE_RETRY_STATUSES ?? '429,503,529')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599),
  )).sort((a, b) => a - b);

  // Each upstream is a full URL (scheme + host + optional path prefix), e.g.
  // https://co.yes.vg/team. Split it into the pieces the dispatcher needs: the
  // request fn is chosen by protocol, host/port address the socket, and prefix is
  // prepended to every route path. A bare host path ("/") yields an empty prefix.
  const parseUpstream = (raw, fallbackRaw) => {
    const u = new URL((raw ?? '').trim() || fallbackRaw);
    return Object.freeze({
      protocol: u.protocol,
      host: u.hostname,
      port: u.port ? Number.parseInt(u.port, 10) : (u.protocol === 'http:' ? 80 : 443),
      prefix: u.pathname.replace(/\/+$/, ''),
    });
  };

  return Object.freeze({
    primary: parseUpstream(process.env.YESCODE_PRIMARY_URL, 'https://co.yes.vg/team'),
    fallback: parseUpstream(process.env.YESCODE_FALLBACK_URL, 'https://co-cdn.yes.vg/team'),
    apiKey: process.env.YESCODE_API_KEY ?? '',
    apiKeyAnthropic: process.env.YESCODE_API_KEY_ANTHROPIC ?? '',
    apiKeyOpenai: process.env.YESCODE_API_KEY_OPENAI ?? '',
    apiKeyGemini: process.env.YESCODE_API_KEY_GEMINI ?? '',
    keyFallbackStatuses,
    retryStatuses,
    // Debug aid: when on, log the (redacted-header) request, the client + upstream
    // bodies, and the upstream response body for every request. Off by default.
    debugBodies: /^(1|true|yes|on)$/i.test((process.env.YESCODE_DEBUG_BODIES ?? '').trim()),
    upstreamTimeoutMs,
    // Real claude-cli formats UA as `claude-cli/<v> (external, <entrypoint>[, agent-sdk/...])`.
    claudeUserAgent: `claude-cli/${claudeCliVersion} (external, ${claudeCliEntrypoint})`,
    // YesCode gates the codex models (gpt-5.x / *-codex on /v1/responses) behind a
    // User-Agent prefix check: a UA starting with `codex` routes to the real Codex
    // app-server, anything else falls through to an unconfigured path that 503s with
    // "Codex app-server responses fallback is not configured". We spoof a codex client
    // on the OpenAI route. `originator` is sent for fidelity but isn't load-bearing.
    codexUserAgent: process.env.YESCODE_CODEX_USER_AGENT ?? `codex_cli_rs/${codexCliVersion}`,
    codexOriginator: process.env.YESCODE_CODEX_ORIGINATOR ?? 'codex_cli_rs',
    // YesCode's gemini upstream 403s on user-agents that look like a competing SDK
    // (e.g. the OpenAI JS SDK). The gemini route forwards the client's UA verbatim,
    // so we override it with an official-looking Google GenAI SDK UA. It's a
    // blacklist (curl and absent UAs pass), so any non-OpenAI value works.
    geminiUserAgent: process.env.YESCODE_GEMINI_USER_AGENT ?? 'google-genai-sdk/1.16.0 gl-node/v22.0.0',
    // `fine-grained-tool-streaming-2025-05-14` was retired by the Claude Code SDK in
    // recent versions; v2.1.75 keeps `interleaved-thinking-2025-05-14` and adds
    // `context-management-2025-06-27`.
    anthropicBeta: process.env.YESCODE_ANTHROPIC_BETA
      ?? 'context-management-2025-06-27,interleaved-thinking-2025-05-14',
    // FULL_FINGERPRINT=1 also injects stainless-SDK telemetry headers and the
    // optional remote-session/container IDs that real claude-code emits in
    // remote (devcontainer / sdk) deployments.
    fullFingerprint: process.env.YESCODE_FULL_FINGERPRINT === '1',
    stainlessHeaders: Object.freeze({
      'X-Stainless-Lang': 'js',
      'X-Stainless-Package-Version': stainlessPackageVersion,
      'X-Stainless-OS': stainlessOS,
      'X-Stainless-Arch': stainlessArch,
      'X-Stainless-Runtime': 'node',
      'X-Stainless-Runtime-Version': process.version,
      'X-Stainless-Retry-Count': '0',
      'X-Stainless-Timeout': String(Math.round(upstreamTimeoutMs / 1000)),
    }),
    // Reuse boot-time UUIDs when the env var is unset so the proxy keeps a
    // stable device fingerprint across reloads.
    remoteContainerId: process.env.YESCODE_REMOTE_CONTAINER_ID || BOOT_CONTAINER_ID,
    remoteSessionId: process.env.YESCODE_REMOTE_SESSION_ID || BOOT_SESSION_ID,
    // Stable device fingerprint baked into metadata.user_id. Holding the
    // device hash constant per proxy instance keeps us looking like one
    // Claude-CLI install rather than a parade of strangers.
    deviceId: createHash('sha256').update(`claude_user_${deviceSeed}`).digest('hex'),
    // Tracked for diff-logging only; runtime keeps using BOOT_PORT/BOOT_BIND.
    port: Number.parseInt(process.env.PORT ?? '18790', 10),
    bind: process.env.BIND ?? '127.0.0.1',
  });
}

const SECRET_KEYS = new Set(['apiKey', 'apiKeyAnthropic', 'apiKeyOpenai', 'apiKeyGemini']);

function configValueDisplay(key, value) {
  if (SECRET_KEYS.has(key)) return maskAuthValue(value);
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function diffConfig(prev, next) {
  const changes = [];
  for (const key of Object.keys(next)) {
    const a = prev[key], b = next[key];
    if (a !== null && typeof a === 'object'
      && b !== null && typeof b === 'object') {
      const ak = Object.keys(a), bk = Object.keys(b);
      const same = ak.length === bk.length && ak.every((k) => a[k] === b[k]);
      if (!same) changes.push(key);
    } else if (a !== b) {
      changes.push(key);
    }
  }
  return changes;
}

let config = (() => {
  try {
    loadEnvFile(ENV_FILE_PATH);
  } catch (err) {
    // Boot path: systemd's EnvironmentFile already populated process.env,
    // so a missing .env on disk is non-fatal here — just log and continue.
    console.warn(`${timestamp()} WARN initial env file load failed: ${err.message}`);
  }
  return loadConfig();
})();

let reloadTimer = null;
function scheduleReload(reason) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    applyReload(reason);
  }, 200);
}

function applyReload(reason) {
  try {
    loadEnvFile(ENV_FILE_PATH);
  } catch (err) {
    console.error(`${timestamp()} reload aborted (${reason}): ${err.message}`);
    return;
  }
  let next;
  try {
    next = loadConfig();
  } catch (err) {
    console.error(`${timestamp()} reload aborted (${reason}): loadConfig threw ${err.message}`);
    return;
  }

  if (next.port !== BOOT_PORT) {
    console.warn(`${timestamp()} WARN PORT ${BOOT_PORT}→${next.port} ignored — restart required to rebind`);
  }
  if (next.bind !== BOOT_BIND) {
    console.warn(`${timestamp()} WARN BIND ${BOOT_BIND}→${next.bind} ignored — restart required to rebind`);
  }

  const changes = diffConfig(config, next).filter((k) => k !== 'port' && k !== 'bind');
  if (changes.length === 0) {
    console.log(`${timestamp()} config reload (${reason}): no changes`);
    config = next;
    return;
  }
  const lines = changes.map((key) => `    ${key}: ${configValueDisplay(key, config[key])} → ${configValueDisplay(key, next[key])}`);
  console.log(`${timestamp()} config reload (${reason}): ${changes.length} changed\n${lines.join('\n')}`);
  config = next;
}

// --- virtual SK edge auth ---
// An allowlist of client-facing "virtual" SKs, loaded from KEYS_FILE_PATH and
// hot-reloaded like .env. This is the ONLY edge gate: downstream the proxy still
// force-overrides the client key with the real upstream credential (see
// buildUpstreamHeaders), so a virtual SK never reaches the upstream — it only
// decides whether a request is let in. Fail-open: an empty / missing / invalid
// file means "no allowlist" and every request passes (backward-compatible with
// the pre-auth proxy). State is an atomically-swapped Map so in-flight requests
// always read a consistent allowlist.
let virtualKeys = new Map();   // sk plaintext -> { label, enabled, expires|null }

function parseKeysFile(text) {
  const data = JSON.parse(text);
  // Accept either { "keys": [...] } or a bare top-level array.
  const list = Array.isArray(data) ? data : data?.keys;
  if (!Array.isArray(list)) throw new Error('expected { "keys": [...] } or a top-level array');
  const next = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    if (!key) continue;
    next.set(key, Object.freeze({
      label: typeof entry.label === 'string' && entry.label ? entry.label : maskMetricKey(key),
      enabled: entry.enabled !== false,   // default true; only an explicit false disables
      expires: typeof entry.expires === 'string' ? entry.expires : null,
    }));
  }
  return next;
}

// Read the allowlist from disk. A missing file is "no allowlist" (empty Map);
// anything else (bad JSON, bad shape, unreadable) throws so the caller can decide
// whether to keep the previous allowlist (reload) or fail-open (boot).
function loadKeysFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
  if (!text.trim()) return new Map();
  return parseKeysFile(text);
}

virtualKeys = (() => {
  try {
    return loadKeysFile(KEYS_FILE_PATH);
  } catch (err) {
    console.warn(`${timestamp()} WARN initial keys file load failed: ${err.message} — auth disabled (fail-open)`);
    return new Map();
  }
})();

let keysReloadTimer = null;
function scheduleKeysReload(reason) {
  if (keysReloadTimer) clearTimeout(keysReloadTimer);
  keysReloadTimer = setTimeout(() => {
    keysReloadTimer = null;
    applyKeysReload(reason);
  }, 200);
}

function applyKeysReload(reason) {
  let next;
  try {
    next = loadKeysFile(KEYS_FILE_PATH);
  } catch (err) {
    // Fail-safe: a malformed edit keeps the current allowlist rather than
    // dropping every key — which, under fail-open, would silently turn auth off.
    console.error(`${timestamp()} keys reload aborted (${reason}): ${err.message} — keeping ${virtualKeys.size} key(s)`);
    return;
  }
  const before = virtualKeys.size;
  virtualKeys = next;   // atomic reference swap
  const mode = next.size === 0 ? 'disabled (fail-open)' : `${next.size} key(s)`;
  console.log(`${timestamp()} keys reload (${reason}): ${before} → ${mode}`);
}

// Pull the presented client key out of the request. Mirrors what the upstream
// header builder strips: Authorization: Bearer <key> (or a raw Authorization
// value) first, then x-api-key. Node lowercases header names.
function presentedClientKey(headers) {
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.trim()) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    return (m ? m[1] : auth).trim();
  }
  const xk = headers['x-api-key'];
  if (typeof xk === 'string' && xk.trim()) return xk.trim();
  return '';
}

// Authorize a presented key against the allowlist. Fail-open: an empty allowlist
// authorizes everything (vkey null → metrics attribute to '(none)'). On success
// vkey is the masked allowlist label (bounded). On rejection vkey is always null
// — a rejected key is attacker-controlled and must never become a metric label.
// reason ∈ missing | unknown | disabled | expired.
function authorizeVirtualKey(presented) {
  if (virtualKeys.size === 0) return { ok: true, vkey: null, reason: null };
  const key = typeof presented === 'string' ? presented.trim() : '';
  if (!key) return { ok: false, vkey: null, reason: 'missing' };
  const rec = virtualKeys.get(key);
  if (!rec) return { ok: false, vkey: null, reason: 'unknown' };
  if (!rec.enabled) return { ok: false, vkey: null, reason: 'disabled' };
  if (rec.expires) {
    const t = Date.parse(rec.expires);
    if (Number.isFinite(t) && t <= Date.now()) return { ok: false, vkey: null, reason: 'expired' };
  }
  return { ok: true, vkey: maskMetricKey(key), reason: null };
}

// --- per-key usage metrics (Prometheus text exposition, zero-dep) ---
// Every series is keyed by a bounded label tuple. The vkey label is always a
// masked allowlist key (or '(none)' when auth is disabled) — never a client-
// supplied value — so cardinality is bounded by the allowlist. rejects_total is
// deliberately label-light (reason only, NO vkey): a rejected key is attacker-
// controlled. requests_total and rejects_total are disjoint — a request lands in
// exactly one of them, so total traffic = sum of both.
const SEP = '\x1f';
const metrics = {
  requests: new Map(),    // vkey│route│status_class -> count
  tokens: new Map(),      // vkey│route│direction -> count
  bytes: new Map(),       // vkey│route -> count
  rejects: new Map(),     // reason -> count
  fallbacks: new Map(),   // vkey│route -> count
  retries: new Map(),     // vkey│route -> count
  lastUsed: new Map(),    // vkey -> unix seconds
};
function inc(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}
function statusClass(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n < 100 || n > 599) return '0xx';
  return `${Math.floor(n / 100)}xx`;
}

// Terminal-outcome hook, fired once per metered request from res.on('close').
// ctx.skip short-circuits outcomes counted elsewhere (auth rejects → rejects_total)
// or not metered at all; health/root/metrics never register the hook in the first
// place. Status comes from the live res at close, so every exit (success, 4xx,
// 502) is attributed without threading status through each return.
function recordOutcome(ctx, res) {
  if (ctx.skip) return;
  const vkey = ctx.vkey ?? '(none)';
  const route = ctx.route ?? 'unknown';
  inc(metrics.requests, `${vkey}${SEP}${route}${SEP}${statusClass(res.statusCode)}`);
  const u = ctx.usage;
  if (u) {
    if (u.in != null) inc(metrics.tokens, `${vkey}${SEP}${route}${SEP}input`, u.in);
    if (u.out != null) inc(metrics.tokens, `${vkey}${SEP}${route}${SEP}output`, u.out);
    if (u.cache_read != null) inc(metrics.tokens, `${vkey}${SEP}${route}${SEP}cache_read`, u.cache_read);
    if (u.cache_write != null) inc(metrics.tokens, `${vkey}${SEP}${route}${SEP}cache_write`, u.cache_write);
  }
  if (ctx.bytes) inc(metrics.bytes, `${vkey}${SEP}${route}`, ctx.bytes);
  metrics.lastUsed.set(vkey, Math.floor(Date.now() / 1000));
}

// Prometheus label-value escaping: backslash, newline, double-quote.
function escLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}
function renderMetrics() {
  const out = [];
  const emit = (name, help, type, map, labelNames) => {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    for (const [k, v] of map) {
      const vals = k.split(SEP);
      const labels = labelNames.map((ln, i) => `${ln}="${escLabel(vals[i] ?? '')}"`).join(',');
      out.push(`${name}{${labels}} ${v}`);
    }
  };
  emit('yescode_requests_total', 'Proxied requests by virtual key, route and status class.', 'counter', metrics.requests, ['vkey', 'route', 'status_class']);
  emit('yescode_tokens_total', 'Tokens by virtual key, route and direction (input/output/cache_read/cache_write).', 'counter', metrics.tokens, ['vkey', 'route', 'direction']);
  emit('yescode_bytes_total', 'Downstream response bytes by virtual key and route.', 'counter', metrics.bytes, ['vkey', 'route']);
  emit('yescode_rejects_total', 'Rejected requests by reason (no key label: rejected keys are unbounded).', 'counter', metrics.rejects, ['reason']);
  emit('yescode_fallbacks_total', 'Key-failure fallbacks (switched to the next credential) by virtual key and route.', 'counter', metrics.fallbacks, ['vkey', 'route']);
  emit('yescode_retries_total', 'Transient-status retries (same credential) by virtual key and route.', 'counter', metrics.retries, ['vkey', 'route']);
  out.push('# HELP yescode_key_last_used_timestamp_seconds Last time a virtual key served a request (unix seconds).');
  out.push('# TYPE yescode_key_last_used_timestamp_seconds gauge');
  for (const [vkey, ts] of metrics.lastUsed) {
    out.push(`yescode_key_last_used_timestamp_seconds{vkey="${escLabel(vkey)}"} ${ts}`);
  }
  return `${out.join('\n')}\n`;
}

function fallbackKeyForRoute(route) {
  if (route === 'anthropic') return { key: config.apiKeyAnthropic, label: 'anthropic' };
  if (route === 'openai' || route === 'openai-chat') return { key: config.apiKeyOpenai, label: 'openai' };
  if (route === 'gemini') return { key: config.apiKeyGemini, label: 'gemini' };
  return { key: '', label: route };
}

// Ordered credential chain for a route: team key first, then the route's
// per-provider fallback key. The proxy walks this list, retrying with the next
// credential when the upstream rejects one with a keyFallbackStatuses code.
// All credentials share the same upstream (host + prefix) — only the key changes.
function credentialsForRoute(route) {
  const creds = [];
  if (config.apiKey) creds.push({ key: config.apiKey, label: 'team' });
  const fb = fallbackKeyForRoute(route);
  if (fb.key) creds.push({ key: fb.key, label: fb.label });
  if (creds.length === 0) creds.push({ key: config.apiKey, label: 'team' });
  return creds;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

// --- debug-body logging (config.debugBodies) ---
const DEBUG_BODY_LIMIT = 16384;
function previewBody(buf) {
  if (buf == null || buf.length === 0) return '(empty)';
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  return s.length > DEBUG_BODY_LIMIT
    ? `${s.slice(0, DEBUG_BODY_LIMIT)}…[+${s.length - DEBUG_BODY_LIMIT} chars]`
    : s;
}
const REDACT_HEADER = /^(authorization|x-api-key|api-key|proxy-authorization|cookie)$/i;
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = REDACT_HEADER.test(k) ? '<redacted>' : v;
  }
  return out;
}

function classifyRoute(urlPath) {
  // Gemini's native API path is `/v1beta/...` — distinct from OpenAI's `/v1/...`.
  if (urlPath.startsWith('/v1beta/')) return 'gemini';
  if (urlPath === '/v1/messages' || urlPath.startsWith('/v1/messages/') || urlPath.startsWith('/v1/messages?')) return 'anthropic';
  if (urlPath === '/v1/chat/completions' || urlPath.startsWith('/v1/chat/completions?')) return 'openai-chat';
  if (urlPath.startsWith('/v1/')) return 'openai';
  return 'unknown';
}

// The /v1/chat/completions endpoint is universal: the model-name prefix picks the
// upstream provider so one OpenAI-shaped request can reach Claude / Gemini / OpenAI.
function providerForModel(model) {
  const m = String(model ?? '');
  if (/^claude/i.test(m)) return 'anthropic';
  if (/^gemini/i.test(m)) return 'gemini';
  // Recognized OpenAI families: gpt-*, o-series (o1/o3/o4…), chatgpt-*, *codex*.
  if (/^gpt/i.test(m) || /^o\d/i.test(m) || /^chatgpt/i.test(m) || /codex/i.test(m)) return 'openai';
  // Last-resort default: anything unrecognized also routes to OpenAI.
  return 'openai';
}

// Anthropic's Messages API requires max_tokens. Chat Completions makes it optional,
// so when a chat client omits it we fall back to this when translating chat→messages.
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

// YesCode gates the higher-tier Claude models (opus-4-x, sonnet-4-6) behind the
// presence of a non-empty `system` field: a request without one is rejected with
// 503 "no capacity available" even though the model is allowed. Real Claude Code
// always sends its identity preamble, so it never trips the gate; a bare client
// (or a translated chat→messages body) may omit system and get 503. We inject
// this minimal default when none is supplied. Only presence is gated upstream —
// the content is not validated — and any client-supplied system is preserved.
const CLAUDE_CODE_SYSTEM_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";

function extractReqMeta(buf, urlPath, route) {
  const geminiMatch = urlPath.match(/\/v1beta\/models\/([^:?]+)/);
  let model = geminiMatch ? geminiMatch[1] : null;
  let maxTokens = null;
  let stream = false;
  if (buf?.length) {
    try {
      const json = JSON.parse(buf.toString('utf8'));
      if (!model && typeof json.model === 'string') model = json.model;
      stream = json.stream === true;
      if (route === 'gemini') {
        maxTokens = json.generationConfig?.maxOutputTokens ?? null;
      } else {
        maxTokens = json.max_tokens ?? json.max_completion_tokens ?? json.max_output_tokens ?? null;
      }
    } catch {
      // ignore
    }
  }
  return { model, maxTokens, stream };
}

function formatUsageParts({ in: inp, out, cache_read: cr, cache_write: cw }) {
  const parts = [];
  if (inp != null) parts.push(`in=${inp}`);
  if (out != null) parts.push(`out=${out}`);
  if (cr) parts.push(`cache_read=${cr}`);
  if (cw) parts.push(`cache_write=${cw}`);
  return parts.length ? parts.join(' ') : null;
}

// Normalize a provider usage object to numeric token counts, or null when no
// field is present. Distinct from formatUsageParts (which renders the same shape
// to a log string): metrics need the raw numbers and the log line needs the
// string, so extraction returns numbers and formatting happens lazily at the two
// sinks (the response log line and recordOutcome).
function usageNums({ in: inp, out, cache_read: cr, cache_write: cw }) {
  if (inp == null && out == null && cr == null && cw == null) return null;
  return { in: inp ?? null, out: out ?? null, cache_read: cr ?? null, cache_write: cw ?? null };
}

function usageFromAnthropic(u) {
  if (!u || typeof u !== 'object') return null;
  return usageNums({
    in: u.input_tokens,
    out: u.output_tokens,
    cache_read: u.cache_read_input_tokens,
    cache_write: u.cache_creation_input_tokens,
  });
}

function usageFromOpenAI(u) {
  if (!u || typeof u !== 'object') return null;
  return usageNums({
    in: u.prompt_tokens ?? u.input_tokens,
    out: u.completion_tokens ?? u.output_tokens,
  });
}

function usageFromGemini(u) {
  if (!u || typeof u !== 'object') return null;
  return usageNums({
    in: u.promptTokenCount,
    out: u.candidatesTokenCount,
  });
}

function extractJSONUsage(buf, route) {
  try {
    const obj = JSON.parse(buf.toString('utf8'));
    if (route === 'anthropic') return usageFromAnthropic(obj.usage);
    if (route === 'openai' || route === 'openai-chat') return usageFromOpenAI(obj.usage);
    if (route === 'gemini') return usageFromGemini(obj.usageMetadata);
  } catch {
    // not JSON, or no usage
  }
  return null;
}

// Parse SSE event stream for usage. For Anthropic we aggregate across
// message_start (input + cache) and message_delta (output) since neither
// event alone has the full picture.
function extractSSEUsage(buf, route) {
  const text = buf.toString('utf8');
  const events = text.split(/\n\n+/);

  if (route === 'anthropic') {
    const agg = { input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null };
    let found = false;
    for (const ev of events) {
      for (const line of ev.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const data = JSON.parse(payload);
          const u = (data.type === 'message_start' && data.message?.usage)
            ? data.message.usage
            : (data.type === 'message_delta' && data.usage)
              ? data.usage
              : null;
          if (!u) continue;
          if (u.input_tokens != null) agg.input_tokens = u.input_tokens;
          if (u.output_tokens != null) agg.output_tokens = u.output_tokens;
          if (u.cache_read_input_tokens != null) agg.cache_read_input_tokens = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens != null) agg.cache_creation_input_tokens = u.cache_creation_input_tokens;
          found = true;
        } catch {
          // ignore
        }
      }
    }
    return found ? usageFromAnthropic(agg) : null;
  }

  for (let i = events.length - 1; i >= 0; i--) {
    for (const line of events[i].split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        if (route === 'openai' || route === 'openai-chat') {
          if (obj.usage) return usageFromOpenAI(obj.usage);
          if (obj.type === 'response.completed' && obj.response?.usage) return usageFromOpenAI(obj.response.usage);
        } else if (route === 'gemini') {
          if (obj.usageMetadata) return usageFromGemini(obj.usageMetadata);
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function buildLegacyUserId(sessionId) {
  return `user_${config.deviceId}_account__session_${sessionId}`;
}

// Returns the rewritten body buffer (or the original if no rewrite needed)
// plus the user_id and session_id we ended up using. Anthropic-route only.
// True when an Anthropic `system` field carries no usable prompt. Handles the
// three shapes the Messages API accepts: absent/null, a plain string, or an
// array of text blocks. Unknown shapes are left alone (return false) so we never
// clobber something a client meant to send.
function isEmptySystem(system) {
  if (system == null) return true;
  if (typeof system === 'string') return system.trim().length === 0;
  if (Array.isArray(system)) {
    return !system.some((block) =>
      block && typeof block === 'object' &&
      typeof block.text === 'string' && block.text.trim().length > 0);
  }
  return false;
}

// Whether metadata.user_id needs to be (re)written to the Claude-CLI legacy
// shape. Already-legacy ids and valid JSON session ids are left untouched.
function needsUserIdRewrite(metadata) {
  const existing = typeof metadata.user_id === 'string' ? metadata.user_id.trim() : '';
  if (!existing) return true;
  if (LEGACY_USER_ID_PATTERN.test(existing)) return false;
  try {
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === 'object' && typeof parsed.session_id === 'string') {
      return false;
    }
  } catch {
    // not JSON, needs rewrite
  }
  return true;
}

function injectClaudeMetadata(body) {
  if (!body?.length) return { body, injected: false, systemInjected: false };
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, injected: false, systemInjected: false };
  }
  if (!json || typeof json !== 'object') return { body, injected: false, systemInjected: false };

  // user_id fingerprint: stamp the Claude-CLI legacy shape when missing/foreign.
  const metadata = (typeof json.metadata === 'object' && json.metadata !== null)
    ? json.metadata
    : {};
  let injected = false;
  if (needsUserIdRewrite(metadata)) {
    const sessionId = typeof metadata.session_id === 'string' && metadata.session_id.length
      ? metadata.session_id
      : randomUUID();
    json.metadata = { ...metadata, user_id: buildLegacyUserId(sessionId) };
    injected = true;
  }

  // system gate: supply a default preamble when the client sent none, so the
  // models YesCode gates on system-presence don't 503. See the constant above.
  let systemInjected = false;
  if (isEmptySystem(json.system)) {
    json.system = CLAUDE_CODE_SYSTEM_PREAMBLE;
    systemInjected = true;
  }

  if (!injected && !systemInjected) return { body, injected: false, systemInjected: false };
  return { body: Buffer.from(JSON.stringify(json), 'utf8'), injected, systemInjected };
}

// ---- /v1/chat/completions ↔ /v1/responses translation ----
//
// Yescode's OpenAI endpoint is /v1/responses only. We accept the older
// Chat Completions shape on /v1/chat/completions, translate to Responses
// for the upstream call, and translate the response (streaming or not)
// back to Chat Completions so OpenAI-SDK clients work unchanged.

function normalizeUserContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string') {
      out.push({ type: 'input_text', text: p.text });
    } else if (p.type === 'image_url' && p.image_url) {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url;
      if (typeof url === 'string') {
        out.push({
          type: 'input_image',
          image_url: url,
          detail: (p.image_url && typeof p.image_url === 'object' && p.image_url.detail) || 'auto',
        });
      }
    }
  }
  return out;
}

function normalizeAssistantTextContent(content) {
  if (typeof content === 'string') return content ? [{ type: 'output_text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (p?.type === 'text' && typeof p.text === 'string' && p.text.length) {
      out.push({ type: 'output_text', text: p.text });
    }
  }
  return out;
}

function chatToResponses(reqBody) {
  let chat;
  try {
    chat = JSON.parse(reqBody.toString('utf8'));
  } catch (err) {
    throw new Error(`invalid JSON body: ${err.message}`);
  }
  if (!chat || typeof chat !== 'object') throw new Error('body is not an object');
  if (!Array.isArray(chat.messages)) throw new Error('missing messages array');

  const out = {};
  if (typeof chat.model === 'string') out.model = chat.model;

  const instructions = [];
  const input = [];
  for (const msg of chat.messages) {
    if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string') continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      if (typeof msg.content === 'string') {
        if (msg.content) instructions.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        const txt = msg.content
          .filter((p) => p?.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('');
        if (txt) instructions.push(txt);
      }
      continue;
    }
    if (msg.role === 'user') {
      const parts = normalizeUserContent(msg.content);
      if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
      continue;
    }
    if (msg.role === 'assistant') {
      const parts = normalizeAssistantTextContent(msg.content);
      if (parts.length) input.push({ type: 'message', role: 'assistant', content: parts });
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || tc.type !== 'function' || !tc.function) continue;
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
          });
        }
      }
      continue;
    }
    if (msg.role === 'tool') {
      const callId = typeof msg.tool_call_id === 'string' && msg.tool_call_id
        ? msg.tool_call_id
        : `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const output = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
          : '';
      input.push({ type: 'function_call_output', call_id: callId, output });
      continue;
    }
    if (msg.role === 'function') {
      // deprecated function role — synthesize a call_id since there's none on the wire
      const callId = `call_${createHash('sha256').update(`fn_${msg.name ?? ''}`).digest('hex').slice(0, 16)}`;
      const output = typeof msg.content === 'string' ? msg.content : '';
      input.push({ type: 'function_call_output', call_id: callId, output });
    }
  }

  out.input = input;
  if (instructions.length) out.instructions = instructions.join('\n\n');

  if (Array.isArray(chat.tools)) {
    out.tools = chat.tools
      .filter((t) => t?.type === 'function' && t.function && typeof t.function.name === 'string')
      .map((t) => {
        const tool = {
          type: 'function',
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        };
        if (t.function.strict !== undefined) tool.strict = t.function.strict;
        return tool;
      });
  }

  if (chat.tool_choice !== undefined) {
    if (typeof chat.tool_choice === 'string') {
      out.tool_choice = chat.tool_choice;
    } else if (chat.tool_choice?.type === 'function' && chat.tool_choice.function?.name) {
      out.tool_choice = { type: 'function', name: chat.tool_choice.function.name };
    }
  }
  if (chat.parallel_tool_calls !== undefined) out.parallel_tool_calls = chat.parallel_tool_calls;
  if (chat.temperature !== undefined) out.temperature = chat.temperature;
  if (chat.top_p !== undefined) out.top_p = chat.top_p;
  if (typeof chat.user === 'string') out.user = chat.user;
  if (chat.metadata && typeof chat.metadata === 'object') out.metadata = chat.metadata;
  if (chat.stream === true) out.stream = true;
  if (chat.seed !== undefined) out.seed = chat.seed;
  if (chat.service_tier !== undefined) out.service_tier = chat.service_tier;
  if (chat.store !== undefined) out.store = chat.store;

  const maxTok = chat.max_completion_tokens ?? chat.max_tokens;
  if (maxTok !== undefined) out.max_output_tokens = maxTok;

  if (chat.response_format && typeof chat.response_format === 'object') {
    const rf = chat.response_format;
    if (rf.type === 'text') out.text = { format: { type: 'text' } };
    else if (rf.type === 'json_object') out.text = { format: { type: 'json_object' } };
    else if (rf.type === 'json_schema' && rf.json_schema) {
      const fmt = {
        type: 'json_schema',
        name: rf.json_schema.name,
        schema: rf.json_schema.schema,
      };
      if (rf.json_schema.strict !== undefined) fmt.strict = rf.json_schema.strict;
      if (rf.json_schema.description) fmt.description = rf.json_schema.description;
      out.text = { format: fmt };
    }
  }

  if (typeof chat.reasoning_effort === 'string') out.reasoning = { effort: chat.reasoning_effort };

  const includeUsage = chat.stream_options?.include_usage !== false;

  return {
    body: Buffer.from(JSON.stringify(out), 'utf8'),
    originalModel: typeof chat.model === 'string' ? chat.model : null,
    stream: chat.stream === true,
    includeUsage,
  };
}

// ---- /v1/chat/completions → Anthropic /v1/messages translation ----
//
// When the chat model is claude*, the same OpenAI-shaped request is translated
// to Anthropic's Messages shape. Scope is text + tools (no vision/images).

// Flatten chat message content to a plain string (text parts only).
function chatContentToPlainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

// Chat content → Anthropic text blocks. Images are dropped (out of scope).
function chatContentToAnthropicBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (p?.type === 'text' && typeof p.text === 'string' && p.text.length) {
      out.push({ type: 'text', text: p.text });
    }
  }
  return out;
}

function parseToolArguments(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  if (raw && typeof raw === 'object') return raw;
  return {};
}

function chatToAnthropic(reqBody) {
  let chat;
  try {
    chat = JSON.parse(reqBody.toString('utf8'));
  } catch (err) {
    throw new Error(`invalid JSON body: ${err.message}`);
  }
  if (!chat || typeof chat !== 'object') throw new Error('body is not an object');
  if (!Array.isArray(chat.messages)) throw new Error('missing messages array');

  const systemParts = [];
  // Anthropic requires alternating user/assistant roles, so adjacent messages
  // that map to the same role (notably tool results, which are user-role blocks)
  // get merged into a single multi-block turn.
  const turns = [];
  const pushBlocks = (role, blocks) => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };

  for (const msg of chat.messages) {
    if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string') continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      const txt = chatContentToPlainText(msg.content);
      if (txt) systemParts.push(txt);
      continue;
    }
    if (msg.role === 'user') {
      pushBlocks('user', chatContentToAnthropicBlocks(msg.content));
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks = chatContentToAnthropicBlocks(msg.content);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || tc.type !== 'function' || !tc.function) continue;
          blocks.push({
            type: 'tool_use',
            id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            name: tc.function.name,
            input: parseToolArguments(tc.function.arguments),
          });
        }
      }
      pushBlocks('assistant', blocks);
      continue;
    }
    if (msg.role === 'tool' || msg.role === 'function') {
      const toolUseId = typeof msg.tool_call_id === 'string' && msg.tool_call_id
        ? msg.tool_call_id
        : `toolu_${createHash('sha256').update(`fn_${msg.name ?? ''}`).digest('hex').slice(0, 24)}`;
      pushBlocks('user', [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: chatContentToPlainText(msg.content),
      }]);
    }
  }

  const out = {};
  if (typeof chat.model === 'string') out.model = chat.model;
  // max_tokens is required by Anthropic; chat clients may omit it.
  out.max_tokens = chat.max_completion_tokens ?? chat.max_tokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  if (systemParts.length) out.system = systemParts.join('\n\n');
  out.messages = turns;

  if (Array.isArray(chat.tools)) {
    const tools = chat.tools
      .filter((t) => t?.type === 'function' && t.function && typeof t.function.name === 'string')
      .map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters && typeof t.function.parameters === 'object'
          ? t.function.parameters
          : { type: 'object', properties: {} },
      }));
    if (tools.length) out.tools = tools;
  }

  if (chat.tool_choice !== undefined && out.tools) {
    if (chat.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (chat.tool_choice === 'required') out.tool_choice = { type: 'any' };
    // 'none' → omit: Anthropic has no direct "disable" choice short of dropping tools.
    else if (chat.tool_choice?.type === 'function' && chat.tool_choice.function?.name) {
      out.tool_choice = { type: 'tool', name: chat.tool_choice.function.name };
    }
  }

  if (chat.temperature !== undefined) out.temperature = chat.temperature;
  if (chat.top_p !== undefined) out.top_p = chat.top_p;
  if (chat.stream === true) out.stream = true;

  const includeUsage = chat.stream_options?.include_usage !== false;

  return {
    body: Buffer.from(JSON.stringify(out), 'utf8'),
    originalModel: typeof chat.model === 'string' ? chat.model : null,
    stream: chat.stream === true,
    includeUsage,
  };
}

// ---- /v1/chat/completions → Gemini generateContent translation ----
//
// When the chat model is gemini*, translate to Gemini's contents shape. The
// model goes in the URL path, not the body. Text + tools; no vision.

// Gemini's schema validator rejects JSON-Schema keywords it doesn't implement.
// Strip the ones the OpenAI tool schemas commonly carry.
function stripGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(stripGeminiSchema);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'additionalProperties' || k === '$schema') continue;
      out[k] = stripGeminiSchema(v);
    }
    return out;
  }
  return node;
}

function chatToGemini(reqBody) {
  let chat;
  try {
    chat = JSON.parse(reqBody.toString('utf8'));
  } catch (err) {
    throw new Error(`invalid JSON body: ${err.message}`);
  }
  if (!chat || typeof chat !== 'object') throw new Error('body is not an object');
  if (!Array.isArray(chat.messages)) throw new Error('missing messages array');

  const systemParts = [];
  const contents = [];
  // Gemini's functionResponse carries the function *name*, not the call id —
  // map each assistant tool_call id back to its name so tool results resolve.
  const toolCallNames = new Map();
  const pushParts = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const msg of chat.messages) {
    if (!msg || typeof msg !== 'object' || typeof msg.role !== 'string') continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      const txt = chatContentToPlainText(msg.content);
      if (txt) systemParts.push(txt);
      continue;
    }
    if (msg.role === 'user') {
      const txt = chatContentToPlainText(msg.content);
      if (txt) pushParts('user', [{ text: txt }]);
      continue;
    }
    if (msg.role === 'assistant') {
      const parts = [];
      const txt = chatContentToPlainText(msg.content);
      if (txt) parts.push({ text: txt });
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || tc.type !== 'function' || !tc.function) continue;
          if (tc.id) toolCallNames.set(tc.id, tc.function.name);
          parts.push({ functionCall: { name: tc.function.name, args: parseToolArguments(tc.function.arguments) } });
        }
      }
      pushParts('model', parts);
      continue;
    }
    if (msg.role === 'tool' || msg.role === 'function') {
      const name = (msg.tool_call_id && toolCallNames.get(msg.tool_call_id)) || msg.name || 'tool';
      const text = chatContentToPlainText(msg.content);
      let response;
      try {
        const parsed = JSON.parse(text);
        response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { content: text };
      } catch {
        response = { content: text };
      }
      pushParts('user', [{ functionResponse: { name, response } }]);
    }
  }

  const out = { contents };
  if (systemParts.length) out.systemInstruction = { parts: systemParts.map((t) => ({ text: t })) };

  if (Array.isArray(chat.tools)) {
    const decls = chat.tools
      .filter((t) => t?.type === 'function' && t.function && typeof t.function.name === 'string')
      .map((t) => {
        const d = { name: t.function.name };
        if (t.function.description) d.description = t.function.description;
        if (t.function.parameters && typeof t.function.parameters === 'object') {
          d.parameters = stripGeminiSchema(t.function.parameters);
        }
        return d;
      });
    if (decls.length) out.tools = [{ functionDeclarations: decls }];
  }

  if (chat.tool_choice !== undefined && out.tools) {
    const fcc = {};
    if (chat.tool_choice === 'auto') fcc.mode = 'AUTO';
    else if (chat.tool_choice === 'required') fcc.mode = 'ANY';
    else if (chat.tool_choice === 'none') fcc.mode = 'NONE';
    else if (chat.tool_choice?.type === 'function' && chat.tool_choice.function?.name) {
      fcc.mode = 'ANY';
      fcc.allowedFunctionNames = [chat.tool_choice.function.name];
    }
    if (fcc.mode) out.toolConfig = { functionCallingConfig: fcc };
  }

  const genConfig = {};
  const maxTok = chat.max_completion_tokens ?? chat.max_tokens;
  if (maxTok !== undefined) genConfig.maxOutputTokens = maxTok;
  if (chat.temperature !== undefined) genConfig.temperature = chat.temperature;
  if (chat.top_p !== undefined) genConfig.topP = chat.top_p;
  if (Object.keys(genConfig).length) out.generationConfig = genConfig;

  const includeUsage = chat.stream_options?.include_usage !== false;

  return {
    body: Buffer.from(JSON.stringify(out), 'utf8'),
    originalModel: typeof chat.model === 'string' ? chat.model : null,
    stream: chat.stream === true,
    includeUsage,
    model: typeof chat.model === 'string' ? chat.model : '',
  };
}

function responsesJsonToChat(json, originalModel) {
  if (!json || json.object !== 'response' || !Array.isArray(json.output)) return null;

  const baseId = typeof json.id === 'string' ? json.id.replace(/^resp_/, '') : randomUUID().replace(/-/g, '');
  const id = `chatcmpl-${baseId}`;
  const created = typeof json.created_at === 'number' ? json.created_at : Math.floor(Date.now() / 1000);
  const model = originalModel || json.model || 'unknown';

  let contentText = '';
  const toolCalls = [];
  let toolIdx = 0;
  for (const item of json.output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === 'output_text' && typeof c.text === 'string') contentText += c.text;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
        index: toolIdx++,
      });
    }
  }

  // YesCode's codex app-server returns the assistant text in the top-level
  // `output_text` aggregate while leaving `output[]` empty on non-stream responses.
  // Fall back to it so chat-completions clients don't receive null content.
  if (!contentText && typeof json.output_text === 'string') contentText = json.output_text;

  let finishReason;
  if (toolCalls.length > 0) finishReason = 'tool_calls';
  else if (json.incomplete_details?.reason === 'max_output_tokens') finishReason = 'length';
  else if (json.incomplete_details?.reason === 'content_filter') finishReason = 'content_filter';
  else finishReason = 'stop';

  const message = { role: 'assistant', content: contentText || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const out = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
  };

  if (json.usage) {
    const inTok = json.usage.input_tokens ?? 0;
    const outTok = json.usage.output_tokens ?? 0;
    out.usage = {
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: json.usage.total_tokens ?? (inTok + outTok),
    };
    if (json.usage.input_tokens_details) out.usage.prompt_tokens_details = json.usage.input_tokens_details;
    if (json.usage.output_tokens_details) out.usage.completion_tokens_details = json.usage.output_tokens_details;
  }
  if (json.system_fingerprint) out.system_fingerprint = json.system_fingerprint;
  return out;
}

function makeJsonTransform({ originalModel, log }) {
  return {
    mode: 'json',
    responseContentType: () => 'application/json; charset=utf-8',
    stripHeaders: ['content-encoding', 'content-length'],
    jsonBody(buf) {
      let json;
      try {
        json = JSON.parse(buf.toString('utf8'));
      } catch (err) {
        log?.warn?.(`chat-json transform: upstream body not JSON (${err.message})`);
        return null;
      }
      const chat = responsesJsonToChat(json, originalModel);
      if (!chat) return null;
      return Buffer.from(JSON.stringify(chat), 'utf8');
    },
  };
}

// ---- Anthropic / Gemini non-stream response → Chat Completions ----

function anthropicJsonToChat(json, originalModel) {
  if (!json || json.type !== 'message' || !Array.isArray(json.content)) return null;
  const id = typeof json.id === 'string'
    ? `chatcmpl-${json.id.replace(/^msg_/, '')}`
    : `chatcmpl-${randomUUID().replace(/-/g, '')}`;
  const created = Math.floor(Date.now() / 1000);
  const model = originalModel || json.model || 'unknown';

  let contentText = '';
  const toolCalls = [];
  let toolIdx = 0;
  for (const block of json.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      contentText += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        index: toolIdx++,
      });
    }
  }

  let finishReason;
  if (json.stop_reason === 'tool_use') finishReason = 'tool_calls';
  else if (json.stop_reason === 'max_tokens') finishReason = 'length';
  else finishReason = 'stop'; // end_turn / stop_sequence / null

  const message = { role: 'assistant', content: contentText || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const out = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
  };
  if (json.usage) {
    const inTok = json.usage.input_tokens ?? 0;
    const outTok = json.usage.output_tokens ?? 0;
    out.usage = { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok };
  }
  return out;
}

function geminiJsonToChat(json, originalModel) {
  if (!json || !Array.isArray(json.candidates) || json.candidates.length === 0) return null;
  const cand = json.candidates[0];
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
  const created = Math.floor(Date.now() / 1000);
  const model = originalModel || json.modelVersion || 'unknown';

  let contentText = '';
  const toolCalls = [];
  let toolIdx = 0;
  const parts = cand?.content?.parts;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.text === 'string') {
        contentText += p.text;
      } else if (p.functionCall) {
        toolCalls.push({
          id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
          index: toolIdx++,
        });
      }
    }
  }

  let finishReason;
  if (toolCalls.length) finishReason = 'tool_calls';
  else if (cand?.finishReason === 'MAX_TOKENS') finishReason = 'length';
  else if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'RECITATION') finishReason = 'content_filter';
  else finishReason = 'stop';

  const message = { role: 'assistant', content: contentText || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const out = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
  };
  if (json.usageMetadata) {
    const inTok = json.usageMetadata.promptTokenCount ?? 0;
    const outTok = json.usageMetadata.candidatesTokenCount ?? 0;
    out.usage = {
      prompt_tokens: inTok,
      completion_tokens: outTok,
      total_tokens: json.usageMetadata.totalTokenCount ?? (inTok + outTok),
    };
  }
  return out;
}

// computeUsage in forwardOnce runs extract*Usage on the *translated* (chat-shaped)
// body first; that misses native field names, so these transforms stash the native
// usage and surface it via getCapturedUsage() for the fallback path.
function makeAnthropicJsonTransform({ originalModel, log }) {
  let capturedUsage = null;
  return {
    mode: 'json',
    responseContentType: () => 'application/json; charset=utf-8',
    stripHeaders: ['content-encoding', 'content-length'],
    jsonBody(buf) {
      let json;
      try {
        json = JSON.parse(buf.toString('utf8'));
      } catch (err) {
        log?.warn?.(`anthropic-json transform: upstream body not JSON (${err.message})`);
        return null;
      }
      if (json?.usage) capturedUsage = { input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens };
      const chat = anthropicJsonToChat(json, originalModel);
      if (!chat) return null;
      return Buffer.from(JSON.stringify(chat), 'utf8');
    },
    getCapturedUsage() { return capturedUsage; },
  };
}

function makeGeminiJsonTransform({ originalModel, log }) {
  let capturedUsage = null;
  return {
    mode: 'json',
    responseContentType: () => 'application/json; charset=utf-8',
    stripHeaders: ['content-encoding', 'content-length'],
    jsonBody(buf) {
      let json;
      try {
        json = JSON.parse(buf.toString('utf8'));
      } catch (err) {
        log?.warn?.(`gemini-json transform: upstream body not JSON (${err.message})`);
        return null;
      }
      if (json?.usageMetadata) {
        capturedUsage = {
          input_tokens: json.usageMetadata.promptTokenCount,
          output_tokens: json.usageMetadata.candidatesTokenCount,
        };
      }
      const chat = geminiJsonToChat(json, originalModel);
      if (!chat) return null;
      return Buffer.from(JSON.stringify(chat), 'utf8');
    },
    getCapturedUsage() { return capturedUsage; },
  };
}

// Responses SSE events we intentionally drop. Most are bracket/closure
// events whose payload duplicates the deltas we already forwarded; the
// reasoning_summary stream isn't surfaced in Chat Completions at all.
const KNOWN_IGNORED_SSE_EVENTS = new Set([
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.done',
  'response.output_item.done',
  'response.function_call_arguments.done',
  'response.refusal.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning.delta',
  'response.reasoning.done',
]);

// Shared Chat Completions SSE framing for all three upstreams. Owns the chunk
// envelope, chat id, role prelude, final finish chunk, optional usage chunk and
// the [DONE] sentinel. Provider transforms drive it via these primitives while
// keeping their own per-event parsing (tool slots, block indices, etc.).
function makeChatChunkEmitter({ originalModel, includeUsage }) {
  let respModel = originalModel || null;
  let respCreated = null;
  let chatId = null;
  let roleEmitted = false;
  let finishReason = null;
  let usageFinal = null;
  let endedCleanly = false;

  const env = (delta, finishReasonChoice = null, extras = {}) => ({
    id: chatId,
    object: 'chat.completion.chunk',
    created: respCreated ?? Math.floor(Date.now() / 1000),
    model: respModel || 'unknown',
    choices: [{ index: 0, delta, finish_reason: finishReasonChoice, logprobs: null }],
    ...extras,
  });

  const wire = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n\n`, 'utf8');

  const ensureChatId = () => {
    if (!chatId) chatId = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
  };

  const ensureRolePrelude = (out) => {
    if (roleEmitted) return;
    ensureChatId();
    roleEmitted = true;
    out.push(wire(env({ role: 'assistant', content: '' })));
  };

  const flushFinal = (out) => {
    if (endedCleanly) return;
    endedCleanly = true;
    ensureRolePrelude(out);
    out.push(wire(env({}, finishReason || 'stop')));
    if (includeUsage && usageFinal) {
      const inTok = usageFinal.input_tokens ?? 0;
      const outTok = usageFinal.output_tokens ?? 0;
      const usage = {
        prompt_tokens: inTok,
        completion_tokens: outTok,
        total_tokens: usageFinal.total_tokens ?? (inTok + outTok),
      };
      if (usageFinal.input_tokens_details) usage.prompt_tokens_details = usageFinal.input_tokens_details;
      if (usageFinal.output_tokens_details) usage.completion_tokens_details = usageFinal.output_tokens_details;
      out.push(wire({
        id: chatId,
        object: 'chat.completion.chunk',
        created: respCreated ?? Math.floor(Date.now() / 1000),
        model: respModel || 'unknown',
        choices: [],
        usage,
      }));
    }
    out.push(Buffer.from('data: [DONE]\n\n', 'utf8'));
  };

  return {
    env,
    wire,
    ensureChatId,
    ensureRolePrelude,
    flushFinal,
    setChatId(id) { if (!chatId && id) chatId = id; },
    setModel(m) { if (m) respModel = m; },
    setCreated(c) { if (typeof c === 'number') respCreated = c; },
    setUsage(u) { if (u) usageFinal = u; },
    setFinishReason(r) { finishReason = r; },
    getFinishReason() { return finishReason; },
    isEnded() { return endedCleanly; },
    getCapturedUsage() { return usageFinal; },
  };
}

function makeSSETransform({ originalModel, includeUsage, log }) {
  const emitter = makeChatChunkEmitter({ originalModel, includeUsage });
  let leftover = '';
  let respIdSet = false;
  const toolSlots = new Map();
  let nextToolIndex = 0;
  const warnedUnknown = new Set();
  let pendingData = [];

  const computeFinishReason = (resp) => {
    if (toolSlots.size > 0 || (resp && Array.isArray(resp.output) && resp.output.some((it) => it?.type === 'function_call'))) {
      return 'tool_calls';
    }
    const reason = resp?.incomplete_details?.reason;
    if (reason === 'max_output_tokens') return 'length';
    if (reason === 'content_filter') return 'content_filter';
    return 'stop';
  };

  const handleEvent = (data, out) => {
    if (!data || typeof data !== 'object') return;
    const t = data.type;
    if (t === 'response.created' || t === 'response.in_progress') {
      const r = data.response;
      if (r) {
        if (r.id && !respIdSet) {
          respIdSet = true;
          emitter.setChatId(`chatcmpl-${String(r.id).replace(/^resp_/, '')}`);
        }
        emitter.setModel(r.model);
        emitter.setCreated(r.created_at);
      }
      return;
    }
    emitter.ensureChatId();
    if (t === 'response.output_item.added') {
      const item = data.item;
      if (item?.type === 'function_call') {
        emitter.ensureRolePrelude(out);
        const slot = { index: nextToolIndex++, call_id: item.call_id, name: item.name };
        toolSlots.set(item.id, slot);
        out.push(emitter.wire(emitter.env({
          tool_calls: [{
            index: slot.index,
            id: slot.call_id,
            type: 'function',
            function: { name: slot.name, arguments: '' },
          }],
        })));
      } else if (item?.type === 'message') {
        emitter.ensureRolePrelude(out);
      }
      return;
    }
    if (t === 'response.output_text.delta') {
      emitter.ensureRolePrelude(out);
      if (typeof data.delta === 'string' && data.delta.length) {
        out.push(emitter.wire(emitter.env({ content: data.delta })));
      }
      return;
    }
    if (t === 'response.function_call_arguments.delta') {
      const slot = toolSlots.get(data.item_id);
      if (slot && typeof data.delta === 'string') {
        out.push(emitter.wire(emitter.env({
          tool_calls: [{ index: slot.index, function: { arguments: data.delta } }],
        })));
      }
      return;
    }
    if (t === 'response.refusal.delta') {
      emitter.ensureRolePrelude(out);
      if (typeof data.delta === 'string') {
        out.push(emitter.wire(emitter.env({ refusal: data.delta })));
      }
      return;
    }
    if (t === 'response.completed' || t === 'response.incomplete' || t === 'response.failed') {
      const resp = data.response;
      if (resp?.usage) emitter.setUsage(resp.usage);
      emitter.setFinishReason(computeFinishReason(resp));
      emitter.flushFinal(out);
      return;
    }
    if (t === 'error') {
      log?.warn?.(`upstream SSE error event: ${JSON.stringify(data).slice(0, 200)}`);
      emitter.setFinishReason(emitter.getFinishReason() || 'stop');
      emitter.flushFinal(out);
      return;
    }
    if (KNOWN_IGNORED_SSE_EVENTS.has(t)) return;
    if (t && !warnedUnknown.has(t)) {
      warnedUnknown.add(t);
      log?.warn?.(`unknown Responses SSE event type: ${t}`);
    }
  };

  return {
    mode: 'stream',
    responseContentType: () => 'text/event-stream; charset=utf-8',
    stripHeaders: ['content-encoding', 'content-length'],
    streamChunk(chunk) {
      const out = [];
      if (chunk === null) {
        if (pendingData.length > 0) {
          const payload = pendingData.join('\n');
          pendingData = [];
          try { handleEvent(JSON.parse(payload), out); } catch { /* malformed tail */ }
        }
        if (!emitter.isEnded()) emitter.flushFinal(out);
        return out;
      }
      leftover += chunk.toString('utf8');
      let nlIdx;
      while ((nlIdx = leftover.indexOf('\n')) !== -1) {
        let line = leftover.slice(0, nlIdx);
        leftover = leftover.slice(nlIdx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (pendingData.length > 0) {
            const payload = pendingData.join('\n');
            pendingData = [];
            try {
              handleEvent(JSON.parse(payload), out);
            } catch (err) {
              log?.warn?.(`malformed SSE data: ${err.message}`);
            }
          }
        } else if (line.startsWith('data:')) {
          pendingData.push(line.slice(5).replace(/^ /, ''));
        }
        // event:, id:, retry:, comment lines are ignored
      }
      return out;
    },
    getCapturedUsage() {
      return emitter.getCapturedUsage();
    },
  };
}

// Shared SSE line buffer → JSON-event dispatcher for the Anthropic/Gemini
// transforms. The upstream's transform supplies handleEvent(data, out); the
// line framing, flush, and usage surfacing are identical to the openai path.
function makeSSEStreamTransform({ emitter, handleEvent, log, label }) {
  let leftover = '';
  let pendingData = [];
  const drain = (out) => {
    if (pendingData.length === 0) return;
    const payload = pendingData.join('\n');
    pendingData = [];
    try { handleEvent(JSON.parse(payload), out); }
    catch (err) { log?.warn?.(`malformed ${label} SSE data: ${err.message}`); }
  };
  return {
    mode: 'stream',
    responseContentType: () => 'text/event-stream; charset=utf-8',
    stripHeaders: ['content-encoding', 'content-length'],
    streamChunk(chunk) {
      const out = [];
      if (chunk === null) {
        drain(out);
        if (!emitter.isEnded()) emitter.flushFinal(out);
        return out;
      }
      leftover += chunk.toString('utf8');
      let nlIdx;
      while ((nlIdx = leftover.indexOf('\n')) !== -1) {
        let line = leftover.slice(0, nlIdx);
        leftover = leftover.slice(nlIdx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') drain(out);
        else if (line.startsWith('data:')) pendingData.push(line.slice(5).replace(/^ /, ''));
        // event:, id:, retry:, comment lines are ignored
      }
      return out;
    },
    getCapturedUsage() {
      return emitter.getCapturedUsage();
    },
  };
}

function makeAnthropicSSETransform({ originalModel, includeUsage, log }) {
  const emitter = makeChatChunkEmitter({ originalModel, includeUsage });
  const toolSlots = new Map(); // anthropic content-block index -> { index: chat tool index }
  let nextToolIndex = 0;
  // Anthropic splits usage across message_start (input) and message_delta (output);
  // mutate one object so the emitter always holds the merged total.
  const usage = { input_tokens: null, output_tokens: null };

  const mapStopReason = (reason) => {
    if (reason === 'tool_use') return 'tool_calls';
    if (reason === 'max_tokens') return 'length';
    return 'stop'; // end_turn / stop_sequence
  };

  const handleEvent = (data, out) => {
    if (!data || typeof data !== 'object') return;
    const t = data.type;
    if (t === 'message_start') {
      const m = data.message;
      if (m) {
        if (m.id) emitter.setChatId(`chatcmpl-${String(m.id).replace(/^msg_/, '')}`);
        emitter.setModel(m.model);
        if (m.usage) {
          if (m.usage.input_tokens != null) usage.input_tokens = m.usage.input_tokens;
          if (m.usage.output_tokens != null) usage.output_tokens = m.usage.output_tokens;
          emitter.setUsage(usage);
        }
      }
      emitter.ensureRolePrelude(out);
      return;
    }
    if (t === 'content_block_start') {
      const cb = data.content_block;
      if (cb?.type === 'tool_use') {
        emitter.ensureRolePrelude(out);
        const slot = { index: nextToolIndex++ };
        toolSlots.set(data.index, slot);
        out.push(emitter.wire(emitter.env({
          tool_calls: [{ index: slot.index, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }],
        })));
      } else if (cb?.type === 'text') {
        emitter.ensureRolePrelude(out);
      }
      return;
    }
    if (t === 'content_block_delta') {
      const d = data.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text.length) {
        emitter.ensureRolePrelude(out);
        out.push(emitter.wire(emitter.env({ content: d.text })));
      } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const slot = toolSlots.get(data.index);
        if (slot) {
          out.push(emitter.wire(emitter.env({
            tool_calls: [{ index: slot.index, function: { arguments: d.partial_json } }],
          })));
        }
      }
      return;
    }
    if (t === 'message_delta') {
      if (data.delta?.stop_reason) emitter.setFinishReason(mapStopReason(data.delta.stop_reason));
      if (data.usage?.output_tokens != null) {
        usage.output_tokens = data.usage.output_tokens;
        emitter.setUsage(usage);
      }
      return;
    }
    if (t === 'message_stop') {
      emitter.flushFinal(out);
      return;
    }
    if (t === 'error') {
      log?.warn?.(`anthropic SSE error event: ${JSON.stringify(data).slice(0, 200)}`);
      emitter.setFinishReason(emitter.getFinishReason() || 'stop');
      emitter.flushFinal(out);
      return;
    }
    // ping, content_block_stop, etc. → ignore
  };

  return makeSSEStreamTransform({ emitter, handleEvent, log, label: 'anthropic' });
}

function makeGeminiSSETransform({ originalModel, includeUsage, log }) {
  const emitter = makeChatChunkEmitter({ originalModel, includeUsage });
  let nextToolIndex = 0;
  const usage = { input_tokens: null, output_tokens: null, total_tokens: null };

  const mapFinish = (reason) => {
    if (reason === 'MAX_TOKENS') return 'length';
    if (reason === 'SAFETY' || reason === 'RECITATION') return 'content_filter';
    return 'stop';
  };

  const handleEvent = (data, out) => {
    if (!data || typeof data !== 'object') return;
    if (data.modelVersion) emitter.setModel(data.modelVersion);
    emitter.ensureChatId();
    if (data.usageMetadata) {
      if (data.usageMetadata.promptTokenCount != null) usage.input_tokens = data.usageMetadata.promptTokenCount;
      if (data.usageMetadata.candidatesTokenCount != null) usage.output_tokens = data.usageMetadata.candidatesTokenCount;
      if (data.usageMetadata.totalTokenCount != null) usage.total_tokens = data.usageMetadata.totalTokenCount;
      emitter.setUsage(usage);
    }
    const cand = Array.isArray(data.candidates) ? data.candidates[0] : null;
    if (!cand) return;
    const parts = cand.content?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.text === 'string' && p.text.length) {
          emitter.ensureRolePrelude(out);
          out.push(emitter.wire(emitter.env({ content: p.text })));
        } else if (p.functionCall) {
          // Gemini emits the whole functionCall in one chunk — name + args together.
          emitter.ensureRolePrelude(out);
          out.push(emitter.wire(emitter.env({
            tool_calls: [{
              index: nextToolIndex++,
              id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
              type: 'function',
              function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
            }],
          })));
        }
      }
    }
    if (cand.finishReason) {
      emitter.setFinishReason(nextToolIndex > 0 ? 'tool_calls' : mapFinish(cand.finishReason));
    }
  };

  return makeSSEStreamTransform({ emitter, handleEvent, log, label: 'gemini' });
}

function buildUpstreamHeaders(reqHeaders, host, route, key) {
  const out = {};
  for (const [name, value] of Object.entries(reqHeaders)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  out.host = host;

  // The proxy owns the client fingerprint on every upstream (claude-cli for the
  // anthropic backend, codex for openai). The caller's own SDK telemetry
  // (x-stainless-*) must never be forwarded: YesCode validates these on
  // /v1/messages and rejects a foreign-SDK fingerprint (e.g. the OpenAI JS SDK's)
  // with a misleading 503 "no capacity available within your access scope". The
  // anthropic fullFingerprint branch re-adds the correct set below.
  for (const k of Object.keys(out)) {
    if (k.toLowerCase().startsWith('x-stainless-')) delete out[k];
  }

  if (route === 'anthropic') {
    for (const k of Object.keys(out)) {
      const lower = k.toLowerCase();
      if (lower === 'x-api-key' || lower === 'authorization'
        || lower === 'user-agent' || lower === 'x-app'
        || lower === 'anthropic-version' || lower === 'anthropic-dangerous-direct-browser-access'
        || lower === 'anthropic-beta' || lower === 'accept') {
        delete out[k];
      }
    }
    out['user-agent'] = config.claudeUserAgent;
    out['x-app'] = 'cli';
    out['anthropic-version'] = '2023-06-01';
    out['anthropic-dangerous-direct-browser-access'] = 'true';
    out['anthropic-beta'] = config.anthropicBeta;
    out['accept'] = 'application/json';
    if (key) out['authorization'] = `Bearer ${key}`;
    if (config.fullFingerprint) {
      Object.assign(out, config.stainlessHeaders);
      out['X-Stainless-Helper-Method'] = 'stream';
      out['x-claude-remote-container-id'] = config.remoteContainerId;
      out['x-claude-remote-session-id'] = config.remoteSessionId;
      out['x-client-app'] = 'cli';
    }
    return out;
  }

  for (const k of Object.keys(out)) {
    const lower = k.toLowerCase();
    if (lower === 'authorization' || lower === 'x-api-key') delete out[k];
    if (lower === 'user-agent'
      && (route === 'openai' || route === 'openai-chat' || route === 'gemini')) delete out[k];
    if (lower === 'originator' && (route === 'openai' || route === 'openai-chat')) delete out[k];
  }
  if (key) {
    out['authorization'] = `Bearer ${key}`;
    out['x-api-key'] = key;
  }
  // YesCode routes codex models to the real app-server only when the UA looks like
  // a codex client; otherwise /v1/responses 503s. See codexUserAgent in loadConfig.
  if (route === 'openai' || route === 'openai-chat') {
    out['user-agent'] = config.codexUserAgent;
    out['originator'] = config.codexOriginator;
  }
  // YesCode's gemini upstream 403s on competing-SDK user-agents. See geminiUserAgent.
  if (route === 'gemini') {
    out['user-agent'] = config.geminiUserAgent;
  }
  return out;
}

function copyResponseHeaders(upstreamHeaders, stripExtra) {
  const out = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (stripExtra && stripExtra.includes(lower)) continue;
    out[name] = value;
  }
  return out;
}

function forwardOnce({ host, port = 443, protocol = 'https:', method, path, headers, body, res, route, log, transform = null, credential = null, heldStatuses = [] }) {
  return new Promise((resolve, reject) => {
    const upstreamHeaders = {
      ...buildUpstreamHeaders(headers, host, route, credential?.key),
      'content-length': Buffer.byteLength(body),
    };
    if (transform) {
      // We're rewriting the body, so an upstream-applied content-encoding
      // (gzip etc.) would leave us unable to parse. Force identity.
      upstreamHeaders['accept-encoding'] = 'identity';
      if (transform.mode === 'stream') upstreamHeaders['accept'] = 'text/event-stream';
      else if (transform.mode === 'json') upstreamHeaders['accept'] = 'application/json';
    }
    const requestFn = protocol === 'http:' ? httpRequest : httpsRequest;
    const upstreamReq = requestFn({
      host,
      port,
      method,
      path,
      headers: upstreamHeaders,
      timeout: config.upstreamTimeoutMs,
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      const ct = String(upstreamRes.headers['content-type'] ?? '').toLowerCase();
      const ok = status >= 200 && status < 300;
      // Decide whether to engage the transform. Errors / mismatched
      // content-types fall through to passthrough so upstream error bodies
      // reach the client untouched.
      let mode = 'passthrough';
      if (transform && ok) {
        if (transform.mode === 'stream' && ct.startsWith('text/event-stream')) mode = 'stream';
        else if (transform.mode === 'json' && ct.includes('application/json')) mode = 'json';
      }

      // Key-failure status with a fallback credential still to try: swallow the
      // (small, passthrough) error body without touching the client response, so
      // the caller can retry with the next credential. Only reached when the
      // caller passed a non-empty heldStatuses, which it does only while a next
      // credential exists — so a held result always leads to a retry, never a
      // dangling un-flushed response.
      if (heldStatuses.includes(status)) {
        let held = 0;
        const heldChunks = [];
        upstreamRes.on('data', (chunk) => {
          held += chunk.length;
          if (config.debugBodies) heldChunks.push(chunk);
        });
        upstreamRes.on('end', () => {
          if (config.debugBodies) log.info(`   resp.held[${status}] ${previewBody(Buffer.concat(heldChunks))}`);
          resolve({ status, bytes: held, held: true });
        });
        upstreamRes.on('error', (err) => resolve({ status, bytes: held, held: true, streamError: err }));
        return;
      }

      let bytes = 0;
      // Bounded capture for usage extraction. JSON responses parse fully if
      // they fit; SSE keeps a rolling tail since the final usage event lives
      // near the stream end. Beyond MAX_CAPTURE we lose the JSON start and
      // only SSE parsing remains viable — acceptable given typical sizes.
      const MAX_CAPTURE = 256 * 1024;
      const captureChunks = [];
      let captureSize = 0;
      const captureChunk = (chunk) => {
        captureChunks.push(chunk);
        captureSize += chunk.length;
        while (captureSize > MAX_CAPTURE && captureChunks.length > 1) {
          captureSize -= captureChunks.shift().length;
        }
      };
      const computeUsage = () => {
        if (captureChunks.length) {
          const buf = Buffer.concat(captureChunks);
          const u = extractJSONUsage(buf, route) ?? extractSSEUsage(buf, route);
          if (u) return u;
        }
        if (transform && transform.getCapturedUsage) {
          const u = transform.getCapturedUsage();
          if (u) return usageNums({ in: u.input_tokens, out: u.output_tokens });
        }
        return null;
      };

      if (mode === 'json') {
        const collected = [];
        upstreamRes.on('data', (chunk) => {
          bytes += chunk.length;
          collected.push(chunk);
        });
        upstreamRes.on('end', () => {
          const raw = Buffer.concat(collected);
          let outBuf = raw;
          let transformed = null;
          try {
            transformed = transform.jsonBody(raw);
          } catch (err) {
            log.warn(`json transform error: ${err.message}`);
          }
          if (transformed) outBuf = transformed;
          const hdrs = transformed
            ? {
              ...copyResponseHeaders(upstreamRes.headers, transform.stripHeaders),
              'content-type': transform.responseContentType?.() ?? 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(outBuf),
            }
            : copyResponseHeaders(upstreamRes.headers);
          try {
            res.writeHead(status, hdrs);
          } catch (err) {
            reject(err);
            return;
          }
          res.end(outBuf);
          captureChunk(outBuf);
          if (config.debugBodies) log.info(`   resp.upstream[${status}] ${previewBody(raw)}`);
          resolve({ status, bytes, usage: computeUsage() });
        });
        upstreamRes.on('error', (err) => {
          log.warn(`upstream stream error from ${host}: ${err.message}`);
          if (!res.writableEnded) res.end();
          resolve({ status, bytes, usage: null, streamError: err });
        });
        return;
      }

      const downstreamHeaders = copyResponseHeaders(upstreamRes.headers, transform?.stripHeaders);
      if (mode === 'stream') {
        const ovr = transform.responseContentType?.();
        if (ovr) downstreamHeaders['content-type'] = ovr;
      }
      try {
        res.writeHead(status, downstreamHeaders);
      } catch (err) {
        upstreamRes.destroy();
        reject(err);
        return;
      }

      if (mode === 'stream') {
        upstreamRes.on('data', (chunk) => {
          bytes += chunk.length;
          let pieces;
          try {
            pieces = transform.streamChunk(chunk);
          } catch (err) {
            log.warn(`sse transform error: ${err.message}`);
            return;
          }
          for (const piece of pieces) {
            captureChunk(piece);
            if (!res.write(piece)) upstreamRes.pause();
          }
        });
        res.on('drain', () => upstreamRes.resume());
        upstreamRes.on('end', () => {
          let tail = [];
          try {
            tail = transform.streamChunk(null);
          } catch (err) {
            log.warn(`sse transform flush error: ${err.message}`);
          }
          for (const piece of tail) {
            captureChunk(piece);
            res.write(piece);
          }
          res.end();
          if (config.debugBodies) log.info(`   resp.stream-out[${status}] ${previewBody(Buffer.concat(captureChunks))}`);
          resolve({ status, bytes, usage: computeUsage() });
        });
        upstreamRes.on('error', (err) => {
          log.warn(`upstream stream error from ${host}: ${err.message}`);
          let tail = [];
          try { tail = transform.streamChunk(null); } catch { /* swallow */ }
          for (const piece of tail) {
            if (!res.writableEnded) res.write(piece);
          }
          if (!res.writableEnded) res.end();
          resolve({ status, bytes, usage: computeUsage(), streamError: err });
        });
        return;
      }

      upstreamRes.on('data', (chunk) => {
        bytes += chunk.length;
        captureChunk(chunk);
        if (!res.write(chunk)) upstreamRes.pause();
      });
      res.on('drain', () => upstreamRes.resume());
      upstreamRes.on('end', () => {
        res.end();
        if (config.debugBodies) log.info(`   resp.upstream[${status}] ${previewBody(Buffer.concat(captureChunks))}`);
        resolve({ status, bytes, usage: computeUsage() });
      });
      upstreamRes.on('error', (err) => {
        log.warn(`upstream stream error from ${host}: ${err.message}`);
        if (!res.writableEnded) res.end();
        resolve({ status, bytes, usage: computeUsage(), streamError: err });
      });
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error(`upstream timeout after ${config.upstreamTimeoutMs}ms`));
    });
    upstreamReq.on('error', (err) => reject(err));

    if (body?.length) upstreamReq.write(body);
    upstreamReq.end();
  });
}

function shouldRetryUpstream(err, headersSent) {
  if (headersSent) return false;
  if (!err) return false;
  const code = err.code ?? '';
  const msg = err.message ?? '';
  return [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
  ].includes(code) || /timeout|socket hang up|socket disconnected|TLS|certificate/i.test(msg);
}

// Backoff schedule (ms) for retrying the primary host on transient failures —
// connection-level errors (socket hang up, ECONNRESET, timeouts) and transient
// upstream statuses (config.retryStatuses). After these the fallback host gets
// one shot. Module-scoped so the startup banner can print it.
const PRIMARY_BACKOFFS_MS = [200, 600];

const server = createServer(async (req, res) => {
  const reqId = shortId();
  const startedAt = performance.now();
  const route = classifyRoute(req.url ?? '/');
  const log = {
    info: (msg) => console.log(`${timestamp()} [${reqId}] ${msg}`),
    warn: (msg) => console.warn(`${timestamp()} [${reqId}] WARN ${msg}`),
    error: (msg) => console.error(`${timestamp()} [${reqId}] ERROR ${msg}`),
  };

  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, primary: config.primary.host, fallback: config.fallback.host }));
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`yescode-proxy listening on ${BOOT_BIND}:${BOOT_PORT}\nupstream: ${config.primary.host}${config.primary.prefix} (fallback: ${config.fallback.host}${config.fallback.prefix})\n`);
    return;
  }

  if (req.method === 'GET' && req.url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(renderMetrics());
    return;
  }

  // Past this point every request is a metered API call. Register the terminal-
  // outcome hook now so any exit below — auth reject, 404, 400, success, 502 — is
  // recorded exactly once when the response socket closes. reqCtx carries what the
  // hook can't read off res (the resolved virtual key, route, usage, byte count).
  const reqCtx = { vkey: null, route, bytes: 0, usage: null, skip: false };
  let recorded = false;
  res.on('close', () => {
    // Defer past nextTick + the promise microtask queue. res 'close' can be
    // emitted from res.end() (inside forwardOnce) via nextTick — i.e. BEFORE the
    // `await forwardOnce` continuation below assigns reqCtx.usage/bytes — so
    // recording inline would miss usage/bytes on every success. setImmediate runs
    // in the check phase, after both, by which point reqCtx is fully populated.
    setImmediate(() => {
      if (recorded) return;
      recorded = true;
      recordOutcome(reqCtx, res);
    });
  });

  // Edge auth: gate on the virtual-SK allowlist before any upstream work. Empty
  // allowlist → fail-open. Additive only — the upstream credential is still
  // injected downstream regardless of which virtual key got the request in.
  const auth = authorizeVirtualKey(presentedClientKey(req.headers));
  if (!auth.ok) {
    inc(metrics.rejects, auth.reason);
    reqCtx.skip = true;   // counted in rejects_total — keep it out of requests_total
    log.warn(`reject ${req.method} ${req.url} — ${auth.reason} key`);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }));
    return;
  }
  reqCtx.vkey = auth.vkey;

  if (route === 'unknown') {
    log.warn(`reject unknown path ${req.method} ${req.url}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `path "${req.url}" is not a yescode-compatible route. Use /v1/chat/completions or /v1/responses (OpenAI), /v1/messages (Anthropic), or /v1beta/* (Gemini).`,
        type: 'not_found',
      },
    }));
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    log.error(`failed to read request body: ${err.message}`);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'failed to read request body', type: 'bad_request' } }));
    return;
  }

  const { model: modelRaw, maxTokens, stream } = extractReqMeta(body, req.url ?? '/', route);
  const model = modelRaw ?? '?';
  // Original client body, before translation/injection rewrites `body`.
  const rawClientBody = body;

  // /v1/chat/completions is universal: the model-name prefix picks the upstream
  // provider. Every other route maps 1:1 to its own provider.
  const upstreamRoute = route === 'openai-chat' ? providerForModel(model) : route;

  // Clients use Gemini's native `/v1beta/...` path, but YesCode serves Gemini
  // under `<prefix>/gemini/v1beta/...` — re-insert the `/gemini` segment upstream.
  // (Without it the upstream falls through to YesCode's web app, 200 + HTML.)
  // upstreamPath is prefix-less here; each attempt prepends its upstream's prefix.
  let upstreamPath = route === 'gemini'
    ? `/gemini${req.url ?? '/'}`
    : `${req.url ?? '/'}`;
  let transform = null;
  let translatedFrom = null;

  if (route === 'openai-chat') {
    try {
      if (upstreamRoute === 'anthropic') {
        const translated = chatToAnthropic(body);
        body = translated.body;
        upstreamPath = `/v1/messages`;
        transform = translated.stream
          ? makeAnthropicSSETransform({ originalModel: translated.originalModel, includeUsage: translated.includeUsage, log })
          : makeAnthropicJsonTransform({ originalModel: translated.originalModel, log });
      } else if (upstreamRoute === 'gemini') {
        const translated = chatToGemini(body);
        body = translated.body;
        // Gemini puts the model in the path; streaming uses a different verb + ?alt=sse.
        const verb = translated.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
        upstreamPath = `/gemini/v1beta/models/${translated.model}:${verb}`;
        transform = translated.stream
          ? makeGeminiSSETransform({ originalModel: translated.originalModel, includeUsage: translated.includeUsage, log })
          : makeGeminiJsonTransform({ originalModel: translated.originalModel, log });
      } else {
        const translated = chatToResponses(body);
        body = translated.body;
        upstreamPath = `/v1/responses`;
        transform = translated.stream
          ? makeSSETransform({ originalModel: translated.originalModel, includeUsage: translated.includeUsage, log })
          : makeJsonTransform({ originalModel: translated.originalModel, log });
      }
    } catch (err) {
      log.warn(`chat->${upstreamRoute} translation failed: ${err.message}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `invalid chat completion request: ${err.message}`,
          type: 'invalid_request_error',
        },
      }));
      return;
    }
    translatedFrom = '/v1/chat/completions';
  }

  // Inject the Claude-CLI fingerprint for anything bound for Anthropic — native
  // /v1/messages or a chat/completions request translated to messages. Runs after
  // translation so the metadata lands on the final upstream body.
  let injected = false;
  let systemInjected = false;
  if (upstreamRoute === 'anthropic') {
    const result = injectClaudeMetadata(body);
    body = result.body;
    injected = result.injected;
    systemInjected = result.systemInjected;
  }

  log.info(`-> ${req.method} ${req.url} route=${route} upstream=${upstreamRoute} model=${model} stream=${stream} bytes=${body.length}${maxTokens != null ? ` max_tokens=${maxTokens}` : ''}${injected ? ' user_id=injected' : ''}${systemInjected ? ' system=injected' : ''}${translatedFrom ? ` translated=${translatedFrom}→${upstreamPath}` : ''}`);

  if (config.debugBodies) {
    log.info(`   req.headers ${JSON.stringify(redactHeaders(req.headers))}`);
    if (translatedFrom) log.info(`   req.client-body ${previewBody(rawClientBody)}`);
    log.info(`   req.upstream-body ${previewBody(body)}`);
  }

  // Attempt schedule: primary upstream first, then the same upstream on each
  // backoff delay, then the fallback upstream once. Drives both connection-error
  // retries and transient-status retries (the held/continue path below). Each
  // upstream carries its own protocol/host/port/prefix (see loadConfig).
  const attempts = [
    { upstream: config.primary, delayMs: 0 },
    ...PRIMARY_BACKOFFS_MS.map((delayMs) => ({ upstream: config.primary, delayMs })),
    { upstream: config.fallback, delayMs: 0 },
  ];

  let lastErr;
  const credentials = credentialsForRoute(upstreamRoute);
  for (let ci = 0; ci < credentials.length; ci += 1) {
    const cred = credentials[ci];
    const hasNextCred = ci < credentials.length - 1;
    let fellBack = false;
    let attemptIdx = 0;

    for (const { upstream, delayMs } of attempts) {
      attemptIdx += 1;
      const { host } = upstream;
      const fullPath = `${upstream.prefix}${upstreamPath}`;
      const hasNextAttempt = attemptIdx < attempts.length;
      // Hold (swallow without flushing) any status we can still act on: key-failure
      // statuses while a fallback credential remains (→ switch key), transient 5xx/429
      // while a retry attempt remains (→ retry same key). The final attempt of the
      // final credential holds nothing, so the real response reaches the client.
      const heldStatuses = [
        ...(hasNextCred ? config.keyFallbackStatuses : []),
        ...(hasNextAttempt ? config.retryStatuses : []),
      ];
      if (delayMs > 0) {
        log.info(`retrying ${host} in ${delayMs}ms (attempt ${attemptIdx}/${attempts.length}, key=${cred.label})`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
      try {
        const result = await forwardOnce({
          host,
          port: upstream.port,
          protocol: upstream.protocol,
          method: req.method ?? 'POST',
          path: fullPath,
          headers: req.headers,
          body,
          res,
          route: upstreamRoute,
          log,
          transform,
          credential: cred,
          heldStatuses,
        });
        const ms = (performance.now() - startedAt).toFixed(0);
        if (result.held) {
          // Key-failure → advance to the next credential. Transient → retry the
          // same credential on the next (backed-off) attempt.
          if (hasNextCred && config.keyFallbackStatuses.includes(result.status)) {
            const next = credentials[ci + 1];
            log.info(`<- ${result.status} ${ms}ms via=${host}${fullPath} key=${cred.label} bytes=${result.bytes} rejected → fallback to ${next.label} key`);
            inc(metrics.fallbacks, `${reqCtx.vkey ?? '(none)'}${SEP}${route}`);
            fellBack = true;
            break;
          }
          log.info(`<- ${result.status} ${ms}ms via=${host}${fullPath} key=${cred.label} bytes=${result.bytes} transient → retry (attempt ${attemptIdx}/${attempts.length})`);
          inc(metrics.retries, `${reqCtx.vkey ?? '(none)'}${SEP}${route}`);
          continue;
        }
        reqCtx.usage = result.usage;
        reqCtx.bytes = result.bytes;
        const usageStr = result.usage ? formatUsageParts(result.usage) : null;
        log.info(`<- ${result.status} ${ms}ms via=${host}${fullPath} key=${cred.label} bytes=${result.bytes}${usageStr ? ` ${usageStr}` : ''}${result.streamError ? ` streamError=${result.streamError.message}` : ''}`);
        return;
      } catch (err) {
        lastErr = err;
        const ms = (performance.now() - startedAt).toFixed(0);
        log.warn(`upstream ${host}${fullPath} failed (${ms}ms, key=${cred.label}): ${err.message ?? err}`);
        if (!shouldRetryUpstream(err, res.headersSent)) break;
      }
    }

    // Advance to the next credential only when the current key was rejected with
    // a key-failure status. Network exhaustion or exhausted transient retries aren't
    // a key problem — give up so we don't burn a fallback key on an unreachable or
    // at-capacity upstream.
    if (!fellBack) break;
  }

  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `all upstreams failed: ${lastErr?.message ?? 'unknown error'}`,
        type: 'upstream_error',
      },
    }));
  } else if (!res.writableEnded) {
    res.end();
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
  console.error(`${timestamp()} clientError: ${err.message}`);
});

server.listen(BOOT_PORT, BOOT_BIND, () => {
  console.log(`${timestamp()} yescode-proxy listening on http://${BOOT_BIND}:${BOOT_PORT}`);
  console.log(`${timestamp()} upstream primary=${config.primary.host}${config.primary.prefix} fallback=${config.fallback.host}${config.fallback.prefix}`);
  const fallbacks = [];
  if (config.apiKeyAnthropic) fallbacks.push('anthropic');
  if (config.apiKeyOpenai) fallbacks.push('openai');
  if (config.apiKeyGemini) fallbacks.push('gemini');
  if (!config.apiKey && fallbacks.length === 0) {
    console.log(`${timestamp()} api-key injection: disabled — clients must supply Authorization/x-api-key`);
  } else {
    const fbDesc = fallbacks.length
      ? `${fallbacks.join(', ')} (retry on ${config.keyFallbackStatuses.join('/')})`
      : 'none';
    console.log(`${timestamp()} key chain: primary=${config.apiKey ? 'team' : '(none)'} fallbacks=${fbDesc}`);
  }
  console.log(`${timestamp()} transient retry: ${config.retryStatuses.join('/')} (backoff ${PRIMARY_BACKOFFS_MS.join('/')}ms, then fallback host)`);
  console.log(`${timestamp()} virtual-key auth: ${virtualKeys.size === 0 ? 'disabled (fail-open, no keys.json)' : `${virtualKeys.size} key(s) from ${KEYS_FILE_PATH}`}`);
  console.log(`${timestamp()} metrics: GET /metrics (Prometheus text, unauthenticated — protect via bind ${BOOT_BIND})`);
  console.log(`${timestamp()} hot-reload: SIGHUP (systemctl reload) + watching ${ENV_FILE_PATH} + ${KEYS_FILE_PATH}`);
});

process.on('SIGHUP', () => {
  console.log(`${timestamp()} SIGHUP received`);
  applyReload('SIGHUP');
  applyKeysReload('SIGHUP');
});

watchFile(ENV_FILE_PATH, { interval: 1000 }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs) return;
  console.log(`${timestamp()} ${ENV_FILE_PATH} changed (mtime ${prev.mtimeMs}→${curr.mtimeMs})`);
  scheduleReload('fs');
});

// Second watcher for the virtual-SK allowlist. mtime 0 → real (file created) and
// real → 0 (file deleted) both fire here; loadKeysFile maps a missing file to an
// empty allowlist, so deleting keys.json hot-disables auth (fail-open).
watchFile(KEYS_FILE_PATH, { interval: 1000 }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs) return;
  console.log(`${timestamp()} ${KEYS_FILE_PATH} changed (mtime ${prev.mtimeMs}→${curr.mtimeMs})`);
  scheduleKeysReload('fs');
});

const shutdown = (signal) => {
  console.log(`${timestamp()} received ${signal}, closing...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
