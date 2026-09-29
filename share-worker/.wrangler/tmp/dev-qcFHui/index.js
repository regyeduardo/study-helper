var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
var GOOGLE_API_BASE = "https://www.googleapis.com";
var TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
var TIME_ZONE = "America/Sao_Paulo";
var KB = 1024;
var LIMITS = { account: 300 * KB, ip: 900 * KB, site: 100 * KB * KB };
var SHARE_DAYS = 3;
var DAY_MS = 24 * 3600 * 1e3;
var CAS_ATTEMPTS = 10;
var SHARED_PREFIX = "shared/";
var SHARED_CACHE = "public, max-age=60";
var SHARE_PATH = /^\/shares\/([A-Za-z0-9_-]{16,64})$/;
var SHARED_FILE_PATH = /^\/shared\/([A-Za-z0-9_-]{16,64})\.json$/;
function allowedOrigin(origin, env) {
  if (!origin) return null;
  const listed = (env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return listed.includes(origin) || LOCAL_ORIGIN.test(origin) ? origin : null;
}
__name(allowedOrigin, "allowedOrigin");
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
__name(json, "json");
function dayOf(time) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(time));
}
__name(dayOf, "dayOf");
async function hashOf(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
__name(hashOf, "hashOf");
function bytesOf(text) {
  return new TextEncoder().encode(text).length;
}
__name(bytesOf, "bytesOf");
function newShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(newShareId, "newShareId");
async function identify(request, env) {
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const response = await fetch(`${env.GOOGLE_API_BASE || GOOGLE_API_BASE}/drive/v3/about?fields=user(emailAddress,permissionId)`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  const permissionId = body?.user?.permissionId;
  return typeof permissionId === "string" && permissionId ? `account-${await hashOf(permissionId)}` : null;
}
__name(identify, "identify");
async function ipKeyOf(request) {
  return `ip-${await hashOf(request.headers.get("CF-Connecting-IP") ?? "unknown")}`;
}
__name(ipKeyOf, "ipKeyOf");
async function turnstilePassed(token, request, env) {
  if (typeof token !== "string" || !token || !env.TURNSTILE_SECRET) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  const response = await fetch(TURNSTILE_URL, { method: "POST", body: form }).catch(() => null);
  const body = await response?.json().catch(() => null);
  return body?.success === true;
}
__name(turnstilePassed, "turnstilePassed");
function counterKey(day, name) {
  return `counters/${day}/${name}.json`;
}
__name(counterKey, "counterKey");
async function readCounter(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return { used: 0, etag: null };
  const body = await object.json().catch(() => ({}));
  return { used: Number(body.used) || 0, etag: object.etag };
}
__name(readCounter, "readCounter");
async function adjust(bucket, key, delta, limit) {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const { used, etag } = await readCounter(bucket, key);
    const next = Math.max(0, used + delta);
    if (delta > 0 && next > limit) return { ok: false, remaining: Math.max(0, limit - used) };
    const written = await bucket.put(key, JSON.stringify({ used: next }), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" }
    });
    if (written) return { ok: true, remaining: Math.max(0, limit - next) };
  }
  throw new Error("counter_busy");
}
__name(adjust, "adjust");
function countersOf(day, accountKey, ipKey) {
  return [
    { name: "account", key: counterKey(day, accountKey), limit: LIMITS.account },
    { name: "ip", key: counterKey(day, ipKey), limit: LIMITS.ip },
    { name: "site", key: counterKey(day, "site"), limit: LIMITS.site }
  ];
}
__name(countersOf, "countersOf");
async function reserve(bucket, counters, bytes) {
  const done = [];
  for (const counter of counters) {
    const result = await adjust(bucket, counter.key, bytes, counter.limit);
    if (!result.ok) {
      for (const previous of done) await adjust(bucket, previous.key, -bytes, previous.limit);
      return { ok: false, failed: counter.name, remaining: result.remaining };
    }
    done.push(counter);
  }
  return { ok: true };
}
__name(reserve, "reserve");
async function quotaOf(bucket, counters) {
  const parts = {};
  for (const counter of counters) {
    const { used } = await readCounter(bucket, counter.key);
    parts[counter.name] = { used, limit: counter.limit };
  }
  const remaining = Math.max(0, Math.min(...counters.map((counter) => counter.limit - parts[counter.name].used)));
  return { remaining, ...parts };
}
__name(quotaOf, "quotaOf");
function hasBinary(text) {
  return text.includes("\0");
}
__name(hasBinary, "hasBinary");
function isText(value) {
  return typeof value === "string" && !hasBinary(value);
}
__name(isText, "isText");
function textOrEmpty(value) {
  return typeof value === "string" ? value : "";
}
__name(textOrEmpty, "textOrEmpty");
function cleanFolder(folder) {
  if (!folder || typeof folder !== "object" || !isText(folder.id) || !isText(folder.name)) return null;
  return {
    id: folder.id,
    name: folder.name,
    parentId: isText(folder.parentId) ? folder.parentId : null,
    position: Number(folder.position) || 0,
    isCourse: folder.isCourse === true,
    description: textOrEmpty(folder.description)
  };
}
__name(cleanFolder, "cleanFolder");
function cleanFile(file) {
  if (!file || typeof file !== "object" || !isText(file.id) || !isText(file.name) || !isText(file.content)) return null;
  if (file.questions !== void 0 && !Array.isArray(file.questions)) return null;
  const questions = file.questions ?? [];
  if (questions.some((question) => !question || typeof question !== "object" || Array.isArray(question) || hasBinary(JSON.stringify(question)))) return null;
  return {
    id: file.id,
    name: file.name,
    folderId: isText(file.folderId) ? file.folderId : null,
    type: textOrEmpty(file.type),
    position: Number(file.position) || 0,
    description: textOrEmpty(file.description),
    tags: Array.isArray(file.tags) ? file.tags.filter(isText) : [],
    content: file.content,
    questions
  };
}
__name(cleanFile, "cleanFile");
function cleanShare(share) {
  if (!share || typeof share !== "object" || share.kind !== "file" && share.kind !== "folder" || !isText(share.title)) return null;
  if (!Array.isArray(share.files) || !share.files.length || share.folders !== void 0 && !Array.isArray(share.folders)) return null;
  const folders = (share.folders ?? []).map(cleanFolder);
  const files = share.files.map(cleanFile);
  if (folders.includes(null) || files.includes(null)) return null;
  return { kind: share.kind, title: share.title, folders, files };
}
__name(cleanShare, "cleanShare");
async function createShare(request, env, headers) {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "text_only" }, 415, headers);
  const input = await request.json().catch(() => null);
  if (!input) return json({ error: "invalid_json" }, 400, headers);
  const accountKey = await identify(request, env);
  if (!accountKey) return json({ error: "login_required" }, 401, headers);
  if (!await turnstilePassed(input.turnstileToken, request, env)) return json({ error: "turnstile_failed" }, 403, headers);
  const share = cleanShare(input.share);
  if (!share) return json({ error: "text_only" }, 415, headers);
  const bytes = bytesOf(JSON.stringify(share));
  const now = Date.now();
  const day = dayOf(now);
  const ipKey = await ipKeyOf(request);
  const counters = countersOf(day, accountKey, ipKey);
  const reserved = await reserve(env.BUCKET, counters, bytes);
  if (!reserved.ok) return json({ error: `${reserved.failed}_limit`, remaining: reserved.remaining, bytes }, 429, headers);
  const id = newShareId();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SHARE_DAYS * DAY_MS).toISOString();
  try {
    await env.BUCKET.put(`${SHARED_PREFIX}${id}.json`, JSON.stringify({ version: 1, id, createdAt, expiresAt, ...share }), {
      httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: SHARED_CACHE },
      customMetadata: { owner: accountKey, ip: ipKey, day, bytes: String(bytes), expiresAt }
    });
  } catch (error) {
    for (const counter of counters) await adjust(env.BUCKET, counter.key, -bytes, counter.limit);
    throw error;
  }
  const quota = await quotaOf(env.BUCKET, counters);
  return json({ id, createdAt, expiresAt, bytes, remaining: quota.remaining }, 201, headers);
}
__name(createShare, "createShare");
async function deleteShare(request, env, headers, id) {
  const accountKey = await identify(request, env);
  if (!accountKey) return json({ error: "login_required" }, 401, headers);
  const key = `${SHARED_PREFIX}${id}.json`;
  const object = await env.BUCKET.head(key);
  if (!object) return json({ error: "not_found" }, 404, headers);
  const meta = object.customMetadata ?? {};
  if (meta.owner !== accountKey) return json({ error: "not_owner" }, 403, headers);
  await env.BUCKET.delete(key);
  const day = dayOf(Date.now());
  const bytes = Number(meta.bytes) || 0;
  const sameDay = meta.day === day;
  if (sameDay && bytes) for (const counter of countersOf(day, meta.owner, meta.ip)) await adjust(env.BUCKET, counter.key, -bytes, counter.limit);
  const quota = await quotaOf(env.BUCKET, countersOf(day, accountKey, await ipKeyOf(request)));
  return json({ returned: sameDay ? bytes : 0, remaining: quota.remaining }, 200, headers);
}
__name(deleteShare, "deleteShare");
async function readQuota(request, env, headers) {
  const accountKey = await identify(request, env);
  if (!accountKey) return json({ error: "login_required" }, 401, headers);
  const day = dayOf(Date.now());
  return json({ day, ...await quotaOf(env.BUCKET, countersOf(day, accountKey, await ipKeyOf(request))) }, 200, headers);
}
__name(readQuota, "readQuota");
async function serveShared(env, headers, id) {
  const object = await env.BUCKET.get(`${SHARED_PREFIX}${id}.json`);
  if (!object || Date.parse(object.customMetadata?.expiresAt ?? "") <= Date.now()) return json({ error: "not_found" }, 404, headers);
  return new Response(object.body, { status: 200, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": SHARED_CACHE } });
}
__name(serveShared, "serveShared");
var index_default = {
  async fetch(request, env) {
    const origin = allowedOrigin(request.headers.get("Origin"), env);
    if (!origin) return new Response("Forbidden", { status: 403 });
    const headers = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const path = new URL(request.url).pathname;
    const shareMatch = path.match(SHARE_PATH);
    const fileMatch = path.match(SHARED_FILE_PATH);
    if (path === "/quota" && request.method === "GET") return readQuota(request, env, headers);
    if (path === "/shares" && request.method === "POST") return createShare(request, env, headers);
    if (shareMatch && request.method === "DELETE") return deleteShare(request, env, headers, shareMatch[1]);
    if (fileMatch && request.method === "GET" && env.SERVE_SHARED === "true") return serveShared(env, headers, fileMatch[1]);
    return json({ error: "not_found" }, 404, headers);
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

// .wrangler/tmp/bundle-zwImSR/middleware-insertion-facade.js
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

// .wrangler/tmp/bundle-zwImSR/middleware-loader.entry.ts
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
  cleanShare,
  dayOf,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
