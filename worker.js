/**
 * Pixiv 作品查看器 · Cloudflare Worker 后端
 *
 * 路由：
 *   GET /api/illust/{pid}     → 作品元数据 + 每页图片地址
 *   GET /img?u={pximg URL}    → 代理 i.pximg.net（补上伪装 Referer，绕开防盗链）
 *   GET /diag?pid={pid}       → 诊断：直连 / 中继 分别能不能通
 *   GET /health               → 健康检查
 *
 * ── 为什么需要中继（2026-10-26 实测，别再试 cookie 那条路）─────────────────
 * CF Worker 出口访问 *.pixiv.net 一律 403（www 的 ajax、app-api 都一样），返回的是
 * pixiv 自己的 HTML 错误页而不是 Cloudflare 挑战页，说明是 pixiv 边缘层按机房 IP 整域拦截。
 * 已排除的假设（都在 /diag 里跑过，结论是四种策略同样 403）：
 *   · 无 cookie / 有 cookie / 原始 cookie 串 / 移动端 UA —— 全部 403
 *   · app-api.pixiv.net（根本不看 cookie 的接口）—— 也 403
 * → 换 UA、加 Referer、补 cookie、剔 cf_clearance 都没用，只能换出口。
 *
 * 但 i.pximg.net 不受影响（CF 直连 200，原图 6.8MB）。所以：
 *   · 元数据（含图片真实路径）走 r.jina.ai 中继，出口不是 CF，能通；
 *   · 图片仍由本 Worker 直接取，速度快、不吃中继额度。
 *
 * ── 关于 jina 中继的两个硬约束 ─────────────────────────────────────────
 *   1. 必须带 `x-return-format: text`。默认返回 markdown，JSON 会被渲染成空内容，
 *      看起来像"没抓到"，其实只是格式不对。
 *   2. 不带 key 时限 20 RPM。所以 API 响应进 caches.default 缓存 10 分钟。
 *      需要更高额度就配 Secret JINA_KEY（https://jina.ai/reader 免费申请）。
 *
 * ── 图片路径为什么必须查接口 ─────────────────────────────────────────
 *   · /ajax/illust/{pid} 未登录时 urls 全为 null，拿不到图片地址。
 *   · 必须用 /ajax/illust/{pid}/pages，它匿名也给完整 URL。
 *   · 不能用 uploadDate 推算：它只精确到分钟，真实路径是秒级，实测差过 31 秒。
 *
 * 部署：Cloudflare Dashboard → Workers & Pages → 编辑代码 → 粘贴本文件 → Deploy
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PIXIV_ORIGIN = "https://www.pixiv.net";
const RELAY_ORIGIN = "https://r.jina.ai/";
const DIRECT_TIMEOUT = 8000;
const RELAY_TIMEOUT = 30000;
const CACHE_TTL = 600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function directHeaders() {
  return {
    "User-Agent": UA,
    Referer: PIXIV_ORIGIN + "/",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
  };
}

function relayHeaders(env) {
  const h = { "User-Agent": UA, "x-return-format": "text" };
  if (env && env.JINA_KEY) h["Authorization"] = "Bearer " + env.JINA_KEY;
  return h;
}

/**
 * 取一个 pixiv JSON 接口。直连优先，失败（403/超时/非 JSON）自动降级到 jina 中继。
 * @returns {Promise<{json:any, via:"direct"|"relay", status:number}>}
 */
async function fetchPixivJson(path, env) {
  let directNote = "";

  try {
    const r = await fetch(PIXIV_ORIGIN + path, {
      headers: directHeaders(),
      signal: AbortSignal.timeout(DIRECT_TIMEOUT),
    });
    const text = await r.text();
    try {
      return { json: JSON.parse(text), via: "direct", status: r.status };
    } catch {
      directNote = "直连 HTTP " + r.status + " 且非 JSON";
    }
  } catch (e) {
    directNote = "直连失败：" + String(e.message || e).slice(0, 60);
  }

  let relayErr;
  try {
    const r = await fetch(RELAY_ORIGIN + PIXIV_ORIGIN + path, {
      headers: relayHeaders(env),
      signal: AbortSignal.timeout(RELAY_TIMEOUT),
    });
    const text = await r.text();
    if (!r.ok) {
      relayErr = new Error(
        "中继 HTTP " +
          r.status +
          (r.status === 429 ? "（免费额度 20 次/分，配 JINA_KEY 可提到 200）" : "") +
          "：" +
          text.slice(0, 120).replace(/\s+/g, " ")
      );
    } else {
      try {
        return { json: JSON.parse(text), via: "relay", status: 200 };
      } catch {
        relayErr = new Error("中继返回非 JSON：" + text.slice(0, 120).replace(/\s+/g, " "));
      }
    }
  } catch (e) {
    relayErr = new Error("中继失败：" + String(e.message || e).slice(0, 90));
  }

  throw new Error(directNote + "；" + relayErr.message);
}

async function apiIllust(pid, env) {
  const base = "/ajax/illust/" + pid;

  let meta, pagesRes;
  try {
    [meta, pagesRes] = await Promise.all([
      fetchPixivJson(base, env),
      fetchPixivJson(base + "/pages", env).catch((e) => ({ json: null, error: e })),
    ]);
  } catch (e) {
    return {
      status: 502,
      obj: {
        error: true,
        message: "取不到 pixiv 数据。直连与中继都失败 —— " + e.message,
      },
    };
  }

  if (meta.json.error) {
    return {
      status: 404,
      obj: { error: true, notFound: true, message: meta.json.message || "作品不存在或已删除" },
      via: meta.via,
    };
  }

  let pages = [],
    regulars = [],
    smalls = [];
  const pj = pagesRes.json;
  if (pj && !pj.error && Array.isArray(pj.body)) {
    for (const p of pj.body) {
      const u = p.urls || {};
      pages.push(u.original || "");
      regulars.push(u.regular || "");
      smalls.push(u.small || "");
    }
  }

  const b = meta.json.body || {};

  return {
    status: 200,
    via: meta.via,
    obj: {
      error: false,
      body: {
        illustId: b.illustId,
        title: b.illustTitle || b.title || "",
        userName: b.userName || "",
        userId: b.userId || "",
        pageCount: b.pageCount || pages.length || 1,
        xRestrict: b.xRestrict || 0,
        illustType: b.illustType || 0,
        createDate: b.createDate || "",
        tags: ((b.tags && b.tags.tags) || []).map((t) => t.tag),
        description: (b.description || "").slice(0, 600),
      },
      pages,
      regular: regulars,
      small: smalls,
      source: "pixiv.net",
    },
  };
}

async function proxyImage(rawTarget, env) {
  if (!rawTarget) return json({ error: true, message: "缺少 u 参数" }, 400);

  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    return json({ error: true, message: "u 参数不是合法 URL" }, 400);
  }

  const ALLOWED = new Set([
    "i.pximg.net",
    "i-cf.pximg.net",
    "img-original.pximg.net",
    "img-master.pximg.net",
  ]);
  if (!ALLOWED.has(target.hostname)) {
    return json({ error: true, message: "只允许代理 pixiv 图床域名" }, 400);
  }

  let res;
  try {
    res = await fetch(target.toString(), {
      headers: {
        Referer: PIXIV_ORIGIN + "/",
        "User-Agent": UA,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
  } catch (e) {
    return json({ error: true, message: "取图失败：" + e.message }, 502);
  }

  if (!res.ok) {
    return new Response("上游返回 " + res.status, {
      status: res.status,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS },
    });
  }

  const h = new Headers(CORS);
  h.set("Content-Type", res.headers.get("Content-Type") || "image/jpeg");
  h.set("Cache-Control", "public, max-age=604800, immutable");
  const len = res.headers.get("Content-Length");
  if (len) h.set("Content-Length", len);

  return new Response(res.body, { status: 200, headers: h });
}

/** 诊断：直连与中继分别能不能拿到 pixiv 的 JSON。 */
async function diag(pid, env, request) {
  const path = "/ajax/illust/" + pid;
  const out = {};

  const probe = async (name, url, headers) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(RELAY_TIMEOUT) });
      const t = await r.text();
      let isJson = false;
      try {
        isJson = !!JSON.parse(t).body;
      } catch {}
      return {
        target: name,
        status: r.status,
        ms: Date.now() - t0,
        pixivJson: isJson,
        head: t.slice(0, 80).replace(/\s+/g, " "),
      };
    } catch (e) {
      return { target: name, status: 0, ms: Date.now() - t0, error: String(e.message).slice(0, 90) };
    }
  };

  out.colo = (request.cf && request.cf.colo) || "?";
  out.jinaKey = env && env.JINA_KEY ? "已配置" : "未配置";
  out.results = await Promise.all([
    probe("直连 pixiv", PIXIV_ORIGIN + path, directHeaders()),
    probe("中继 jina", RELAY_ORIGIN + PIXIV_ORIGIN + path, relayHeaders(env)),
  ]);
  out.error = false;
  out.pid = pid;
  return json(out);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: true, message: "只支持 GET" }, 405);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "pixiv-viewer-worker",
        routes: [
          "GET /api/illust/{pid}",
          "GET /img?u={i.pximg.net URL}",
          "GET /diag?pid={pid}",
        ],
        relay: "r.jina.ai",
        jinaKey: env && env.JINA_KEY ? "已配置" : "未配置",
      });
    }

    if (url.pathname === "/diag") {
      const pid = (url.searchParams.get("pid") || "115282819").replace(/\D/g, "");
      return diag(pid, env, request);
    }

    const m = url.pathname.match(/^\/api\/illust\/(\d{1,12})$/);
    if (m) {
      const cache = caches.default;
      const key = new Request(url.toString(), { method: "GET" });

      const hit = await cache.match(key);
      if (hit) {
        const r = new Response(hit.body, { status: hit.status, headers: hit.headers });
        r.headers.set("X-Cache", "HIT");
        return r;
      }

      const { status, obj, via } = await apiIllust(m[1], env);
      const resp = json(obj, status, {
        "Cache-Control": status === 200 ? "public, max-age=" + CACHE_TTL : "no-store",
        "X-Data-Via": via || "none",
        "X-Cache": "MISS",
      });

      if (status === 200) {
        ctx.waitUntil(cache.put(key, resp.clone()));
      }
      return resp;
    }

    if (url.pathname === "/img") {
      return proxyImage(url.searchParams.get("u"), env);
    }

    return json({ error: true, message: "未知路由：" + url.pathname }, 404);
  },
};
