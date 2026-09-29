var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var DEEPINFRA_URL = "https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo";
var GOOGLE_API_BASE = "https://www.googleapis.com";
var LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
var TIME_ZONE = "America/Sao_Paulo";
var ACCOUNT_DAILY_SECONDS = 30 * 60;
var IP_DAILY_SECONDS = 90 * 60;
var MAX_AUDIO_BYTES = 100 * 1024 * 1024;
var WAV_HEADER_BYTES = 44;
var WRITE_ATTEMPTS = 8;
var CounterBusy = class extends Error {
  static {
    __name(this, "CounterBusy");
  }
};
function allowedOrigin(origin, env) {
  if (!origin) return null;
  const listed = (env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return listed.includes(origin) || LOCAL_ORIGIN.test(origin) ? origin : null;
}
__name(allowedOrigin, "allowedOrigin");
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
__name(json, "json");
function dayOf(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
__name(dayOf, "dayOf");
function counterKeys(day, person, ip) {
  return {
    account: `counters/transcription/${day}/account/${encodeURIComponent(person)}.json`,
    ip: `counters/transcription/${day}/ip/${encodeURIComponent(ip)}.json`
  };
}
__name(counterKeys, "counterKeys");
async function personOf(request, env) {
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const response = await fetch(`${env.GOOGLE_API_BASE || GOOGLE_API_BASE}/drive/v3/about?fields=user(emailAddress,permissionId)`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  return typeof body?.user?.permissionId === "string" && body.user.permissionId ? body.user.permissionId : null;
}
__name(personOf, "personOf");
async function secondsIn(object) {
  if (!object) return 0;
  const body = await object.json().catch(() => null);
  return Number(body?.seconds) || 0;
}
__name(secondsIn, "secondsIn");
async function addSeconds(bucket, key, seconds) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const object = await bucket.get(key);
    const used = await secondsIn(object);
    const onlyIf = object ? { etagMatches: object.etag } : new Headers({ "If-None-Match": "*" });
    const written = await bucket.put(key, JSON.stringify({ seconds: used + seconds }), { onlyIf, httpMetadata: { contentType: "application/json" } });
    if (written) return;
  }
  throw new CounterBusy();
}
__name(addSeconds, "addSeconds");
async function balanceOf(env, day, person, ip) {
  const keys = counterKeys(day, person, ip);
  const [account, address] = await Promise.all([env.BUCKET.get(keys.account).then(secondsIn), env.BUCKET.get(keys.ip).then(secondsIn)]);
  const accountLeft = Math.max(0, ACCOUNT_DAILY_SECONDS - account);
  const ipLeft = Math.max(0, IP_DAILY_SECONDS - address);
  return { day, keys, accountLeft, ipLeft, remaining: Math.min(accountLeft, ipLeft) };
}
__name(balanceOf, "balanceOf");
function balanceBody(balance, used = 0) {
  return {
    day: balance.day,
    remaining_seconds: Math.max(0, balance.remaining - used),
    account_remaining_seconds: Math.max(0, balance.accountLeft - used),
    ip_remaining_seconds: Math.max(0, balance.ipLeft - used),
    account_daily_seconds: ACCOUNT_DAILY_SECONDS,
    ip_daily_seconds: IP_DAILY_SECONDS
  };
}
__name(balanceBody, "balanceBody");
async function wavSeconds(audio) {
  if (audio.size <= WAV_HEADER_BYTES) return null;
  const head = new Uint8Array(await audio.slice(0, WAV_HEADER_BYTES).arrayBuffer());
  const tag = /* @__PURE__ */ __name((offset) => String.fromCharCode(...head.subarray(offset, offset + 4)), "tag");
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  const byteRate = new DataView(head.buffer).getUint32(28, true);
  return byteRate ? (audio.size - WAV_HEADER_BYTES) / byteRate : null;
}
__name(wavSeconds, "wavSeconds");
async function transcribe(request, env, balance, headers) {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_AUDIO_BYTES) return json({ error: "too_large" }, 413, headers);
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!audio || typeof audio === "string") return json({ error: "missing_audio" }, 400, headers);
  if (audio.size > MAX_AUDIO_BYTES) return json({ error: "too_large" }, 413, headers);
  const seconds = await wavSeconds(audio);
  if (seconds === null) return json({ error: "wav_only" }, 415, headers);
  if (seconds > balance.remaining) return json({ error: "no_minutes", audio_seconds: seconds, ...balanceBody(balance) }, 429, headers);
  const upstream = new FormData();
  upstream.append("audio", audio, "audio.wav");
  const language = form.get("language");
  if (typeof language === "string" && language) upstream.append("language", language);
  const response = await fetch(env.DEEPINFRA_URL || DEEPINFRA_URL, { method: "POST", headers: { Authorization: `bearer ${env.DEEPINFRA_API_KEY}` }, body: upstream }).catch(() => null);
  if (!response) return json({ error: "upstream_unreachable" }, 502, headers);
  if (!response.ok) return json({ error: "upstream_error", status: response.status }, 502, headers);
  const body = await response.json().catch(() => null);
  if (!body) return json({ error: "upstream_invalid" }, 502, headers);
  const used = Number(body.input_length_ms) / 1e3 || Number(body.duration) || seconds;
  await Promise.allSettled([addSeconds(env.BUCKET, balance.keys.account, used), addSeconds(env.BUCKET, balance.keys.ip, used)]);
  const segments = Array.isArray(body.segments) ? body.segments.map((segment) => ({ start: Number(segment.start) || 0, end: Number(segment.end) || 0, text: String(segment.text ?? "") })) : [];
  return json({ text: String(body.text ?? ""), segments, language: String(body.language ?? ""), duration: used, ...balanceBody(balance, used) }, 200, headers);
}
__name(transcribe, "transcribe");
var index_default = {
  async fetch(request, env) {
    const origin = allowedOrigin(request.headers.get("Origin"), env);
    if (!origin) return new Response("Forbidden", { status: 403 });
    const headers = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const path = new URL(request.url).pathname;
    const route = `${request.method} ${path}`;
    if (route !== "GET /balance" && route !== "POST /transcribe") return json({ error: "not_found" }, 404, headers);
    try {
      const person = await personOf(request, env);
      if (!person) return json({ error: "login_required" }, 401, headers);
      const balance = await balanceOf(env, dayOf(/* @__PURE__ */ new Date()), person, request.headers.get("CF-Connecting-IP") ?? "unknown");
      if (route === "GET /balance") return json(balanceBody(balance), 200, headers);
      return await transcribe(request, env, balance, headers);
    } catch (error) {
      return json({ error: error instanceof CounterBusy ? "counter_busy" : "internal" }, error instanceof CounterBusy ? 503 : 500, headers);
    }
  }
};

// ../../../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-yBHiEU/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = index_default;

// ../../../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-yBHiEU/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
