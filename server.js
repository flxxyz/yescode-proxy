import { createServer } from 'node:http';
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
  const upstreamTimeoutMs = Number.parseInt(process.env.YESCODE_TIMEOUT_MS ?? '3600000', 10);
  const claudeCliVersion = process.env.YESCODE_CLAUDE_CLI_VERSION ?? '2.1.75';
  const claudeCliEntrypoint = process.env.YESCODE_CLAUDE_CLI_ENTRYPOINT ?? 'cli';
  const stainlessPackageVersion = process.env.YESCODE_STAINLESS_VERSION ?? '0.74.0';
  const deviceSeed = process.env.YESCODE_DEVICE_SEED ?? 'yescode-proxy-default';

  return Object.freeze({
    primaryHost: process.env.YESCODE_PRIMARY ?? 'co.yes.vg',
    fallbackHost: process.env.YESCODE_FALLBACK ?? 'co-cdn.yes.vg',
    pathPrefix: (process.env.YESCODE_PATH_PREFIX ?? '').replace(/\/+$/, ''),
    apiKey: process.env.YESCODE_API_KEY ?? '',
    apiKeyAnthropic: process.env.YESCODE_API_KEY_ANTHROPIC ?? '',
    apiKeyOpenai: process.env.YESCODE_API_KEY_OPENAI ?? '',
    apiKeyGemini: process.env.YESCODE_API_KEY_GEMINI ?? '',
    upstreamTimeoutMs,
    // Real claude-cli formats UA as `claude-cli/<v> (external, <entrypoint>[, agent-sdk/...])`.
    claudeUserAgent: `claude-cli/${claudeCliVersion} (external, ${claudeCliEntrypoint})`,
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

function keyForRoute(route) {
  if (route === 'anthropic' && config.apiKeyAnthropic) return config.apiKeyAnthropic;
  if (route === 'openai' && config.apiKeyOpenai) return config.apiKeyOpenai;
  if (route === 'gemini' && config.apiKeyGemini) return config.apiKeyGemini;
  return config.apiKey;
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

function classifyRoute(urlPath) {
  if (urlPath.startsWith('/gemini/')) return 'gemini';
  if (urlPath === '/v1/messages' || urlPath.startsWith('/v1/messages/') || urlPath.startsWith('/v1/messages?')) return 'anthropic';
  if (urlPath.startsWith('/v1/')) return 'openai';
  return 'unknown';
}

function extractReqMeta(buf, urlPath, route) {
  const geminiMatch = urlPath.match(/\/gemini\/[^/]+\/models\/([^:?]+)/);
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

function usageFromAnthropic(u) {
  if (!u || typeof u !== 'object') return null;
  return formatUsageParts({
    in: u.input_tokens,
    out: u.output_tokens,
    cache_read: u.cache_read_input_tokens,
    cache_write: u.cache_creation_input_tokens,
  });
}

function usageFromOpenAI(u) {
  if (!u || typeof u !== 'object') return null;
  return formatUsageParts({
    in: u.prompt_tokens ?? u.input_tokens,
    out: u.completion_tokens ?? u.output_tokens,
  });
}

function usageFromGemini(u) {
  if (!u || typeof u !== 'object') return null;
  return formatUsageParts({
    in: u.promptTokenCount,
    out: u.candidatesTokenCount,
  });
}

function extractJSONUsage(buf, route) {
  try {
    const obj = JSON.parse(buf.toString('utf8'));
    if (route === 'anthropic') return usageFromAnthropic(obj.usage);
    if (route === 'openai') return usageFromOpenAI(obj.usage);
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
        if (route === 'openai') {
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
function injectClaudeMetadata(body) {
  if (!body?.length) return { body, injected: false };
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, injected: false };
  }
  if (!json || typeof json !== 'object') return { body, injected: false };

  const metadata = (typeof json.metadata === 'object' && json.metadata !== null)
    ? json.metadata
    : {};
  const existing = typeof metadata.user_id === 'string' ? metadata.user_id.trim() : '';
  if (existing && LEGACY_USER_ID_PATTERN.test(existing)) {
    return { body, injected: false };
  }
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && typeof parsed.session_id === 'string') {
        return { body, injected: false };
      }
    } catch {
      // not JSON, fall through and rewrite
    }
  }

  const sessionId = typeof metadata.session_id === 'string' && metadata.session_id.length
    ? metadata.session_id
    : randomUUID();
  json.metadata = { ...metadata, user_id: buildLegacyUserId(sessionId) };
  return { body: Buffer.from(JSON.stringify(json), 'utf8'), injected: true };
}

function buildUpstreamHeaders(reqHeaders, host, route) {
  const out = {};
  for (const [name, value] of Object.entries(reqHeaders)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  out.host = host;

  const key = keyForRoute(route);

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
  }
  if (key) {
    out['authorization'] = `Bearer ${key}`;
    out['x-api-key'] = key;
  }
  return out;
}

function copyResponseHeaders(upstreamHeaders) {
  const out = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

function forwardOnce({ host, method, path, headers, body, res, route, log }) {
  return new Promise((resolve, reject) => {
    const upstreamHeaders = {
      ...buildUpstreamHeaders(headers, host, route),
      'content-length': Buffer.byteLength(body),
    };
    const upstreamReq = httpsRequest({
      host,
      port: 443,
      method,
      path,
      headers: upstreamHeaders,
      timeout: config.upstreamTimeoutMs,
    }, (upstreamRes) => {
      let bytes = 0;
      // Bounded capture for usage extraction. JSON responses parse fully if
      // they fit; SSE keeps a rolling tail since the final usage event lives
      // near the stream end. Beyond MAX_CAPTURE we lose the JSON start and
      // only SSE parsing remains viable — acceptable given typical sizes.
      const MAX_CAPTURE = 256 * 1024;
      const captureChunks = [];
      let captureSize = 0;
      try {
        res.writeHead(upstreamRes.statusCode ?? 502, copyResponseHeaders(upstreamRes.headers));
      } catch (err) {
        upstreamRes.destroy();
        reject(err);
        return;
      }
      upstreamRes.on('data', (chunk) => {
        bytes += chunk.length;
        captureChunks.push(chunk);
        captureSize += chunk.length;
        while (captureSize > MAX_CAPTURE && captureChunks.length > 1) {
          captureSize -= captureChunks.shift().length;
        }
        if (!res.write(chunk)) upstreamRes.pause();
      });
      res.on('drain', () => upstreamRes.resume());
      upstreamRes.on('end', () => {
        res.end();
        let usage = null;
        if (captureChunks.length) {
          const buf = Buffer.concat(captureChunks);
          usage = extractJSONUsage(buf, route) ?? extractSSEUsage(buf, route);
        }
        resolve({ status: upstreamRes.statusCode ?? 0, bytes, usage });
      });
      upstreamRes.on('error', (err) => {
        log.warn(`upstream stream error from ${host}: ${err.message}`);
        if (!res.writableEnded) res.end();
        let usage = null;
        if (captureChunks.length) {
          const buf = Buffer.concat(captureChunks);
          usage = extractJSONUsage(buf, route) ?? extractSSEUsage(buf, route);
        }
        resolve({ status: upstreamRes.statusCode ?? 0, bytes, usage, streamError: err });
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
  return [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
  ].includes(code) || /timeout/i.test(err.message ?? '');
}

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
    res.end(JSON.stringify({ ok: true, primary: config.primaryHost, fallback: config.fallbackHost }));
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`yescode-proxy listening on ${BOOT_BIND}:${BOOT_PORT}\nupstream: ${config.primaryHost} (fallback: ${config.fallbackHost})\n`);
    return;
  }

  if (route === 'unknown') {
    log.warn(`reject unknown path ${req.method} ${req.url}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `path "${req.url}" is not a yescode-compatible route. Use /v1/* (OpenAI), /v1/messages (Anthropic), or /gemini/* (Gemini).`,
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

  let injected = false;
  if (route === 'anthropic') {
    const result = injectClaudeMetadata(body);
    body = result.body;
    injected = result.injected;
  }

  log.info(`-> ${req.method} ${req.url} route=${route} model=${model} stream=${stream} bytes=${body.length}${maxTokens != null ? ` max_tokens=${maxTokens}` : ''}${injected ? ' user_id=injected' : ''}`);

  const upstreamPath = `${config.pathPrefix}${req.url ?? '/'}`;
  const hosts = [config.primaryHost, config.fallbackHost];

  let lastErr;
  for (const host of hosts) {
    try {
      const result = await forwardOnce({
        host,
        method: req.method ?? 'POST',
        path: upstreamPath,
        headers: req.headers,
        body,
        res,
        route,
        log,
      });
      const ms = (performance.now() - startedAt).toFixed(0);
      log.info(`<- ${result.status} ${ms}ms via=${host}${upstreamPath} bytes=${result.bytes}${result.usage ? ` ${result.usage}` : ''}${result.streamError ? ` streamError=${result.streamError.message}` : ''}`);
      return;
    } catch (err) {
      lastErr = err;
      const ms = (performance.now() - startedAt).toFixed(0);
      log.warn(`upstream ${host}${upstreamPath} failed (${ms}ms): ${err.message ?? err}`);
      if (!shouldRetryUpstream(err, res.headersSent)) break;
      log.info(`retrying via fallback host`);
    }
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
  console.log(`${timestamp()} upstream primary=${config.primaryHost}${config.pathPrefix} fallback=${config.fallbackHost}${config.pathPrefix}`);
  const slots = [];
  if (config.apiKeyAnthropic) slots.push('anthropic');
  if (config.apiKeyOpenai) slots.push('openai');
  if (config.apiKeyGemini) slots.push('gemini');
  if (config.apiKey) slots.push('fallback');
  console.log(`${timestamp()} api-key injection: ${slots.length ? slots.join(', ') : 'disabled — clients must supply Authorization/x-api-key'}`);
  console.log(`${timestamp()} hot-reload: SIGHUP (systemctl reload) + watching ${ENV_FILE_PATH}`);
});

process.on('SIGHUP', () => {
  console.log(`${timestamp()} SIGHUP received`);
  applyReload('SIGHUP');
});

watchFile(ENV_FILE_PATH, { interval: 1000 }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs) return;
  console.log(`${timestamp()} ${ENV_FILE_PATH} changed (mtime ${prev.mtimeMs}→${curr.mtimeMs})`);
  scheduleReload('fs');
});

const shutdown = (signal) => {
  console.log(`${timestamp()} received ${signal}, closing...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
