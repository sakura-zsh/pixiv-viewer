/**
 * Pixiv 作品查看器 · Cloudflare Worker 后端
 *
 * 路由：
 *   GET /api/illust/{pid}     → 作品元数据 + 每页图片地址
 *   GET /img?u={pximg URL}    → 代理 i.pximg.net（补上伪装 Referer，绕开防盗链）
 *   GET /diag?pid={pid}       → 诊断各上游策略从 CF 出口的可用性
 *   GET /health               → 健康检查
 *
 * 关键实现说明（都是实测结论，别随手改）：
 *   1. /ajax/illust/{pid} 在未登录时 urls 全为 null，拿不到图片地址。
 *   2. /ajax/illust/{pid}/pages 未登录也能返回完整 URL —— 图片地址必须走这个接口。
 *   3. 不能用 uploadDate 自己推算路径：uploadDate 只精确到分钟，
 *      而 pximg 路径是秒级上传时间，实测差了 31 秒。
 *   4. i.pximg.net 强制校验 Referer：空 Referer 和第三方 Referer 都是 403，
 *      必须带 https://www.pixiv.net/ 才能 200。所以图片必须经本 Worker 转发。
 *   5. CF Worker 出口访问 www.pixiv.net 会被 pixiv 按机房 IP 返回 403（标题是 pixiv 的
 *      HTML 错误页，不是 Cloudflare 挑战页）；i.pximg.net 不受影响。
 *      → 靠 PIXIV_COOKIE 缓解；诊断见 /diag。
 *   6. cf_clearance / __cf_bm / _cfuvid 是绑 IP + UA 的，从 CF 出口发出去必然无效，
 *      原样发送反而可能加重校验。所以统一先剔除（见 filterCookie）。
 *
 * 可选 Secret：
 *   PIXIV_COOKIE —— 浏览器里 pixiv 的完整 Cookie 串（未剔除的部分会自动过滤）
 *
 * 部署：Cloudflare Dashboard → Workers & Pages → Create Worker → 粘贴本文件 → Deploy
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MOBILE_UA =
  "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// 绑 IP / UA 的 cookie，跨出口发送无意义且可能触发更严校验
const DROP_COOKIES = new Set([
  "cf_clearance",
  "__cf_bm",
  "_cfuvid",
  "__cflb",
  "__cfruid",
  "cf_chl_2",
  "cf_chl_prog",
  "cf_chl_seq",
]);

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function splitCookie(raw) {
  const kept = [];
  const dropped = [];
  if (!raw) return { kept, dropped };
  for (const part of String(raw).split(";")) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    const name = (eq === -1 ? s : s.slice(0, eq)).trim();
    if (DROP_COOKIES.has(name)) dropped.push(name);
    else kept.push(s);
  }
  return { kept, dropped };
}

function filterCookie(raw) {
  return splitCookie(raw).kept.join("; ");
}

function pixivHeaders(env, { ua = UA, cookie = null } = {}) {
  const h = {
    "User-Agent": ua,
    Referer: "https://www.pixiv.net/",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
  };
  const ck = cookie === null ? filterCookie(env && env.PIXIV_COOKIE) : cookie;
  if (ck) h["Cookie"] = ck;
  return h;
}

async function apiIllust(pid, env) {
  const base = `https://www.pixiv.net/ajax/illust/${pid}`;
  const headers = pixivHeaders(env);
  const opt = { headers, cf: { cacheTtl: 180, cacheEverything: true } };

  let metaRes, pagesRes;
  try {
    [metaRes, pagesRes] = await Promise.all([
      fetch(base, opt),
      fetch(base + "/pages", opt),
    ]);
  } catch (e) {
    return json({ error: true, message: "无法连接 pixiv：" + e.message }, 502);
  }

  const metaText = await metaRes.text();
  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch {
    const hint =
      metaRes.status === 403
        ? "pixiv 拒绝了本 Worker 的出口 IP（机房 IP 封禁）。缓解办法：设置 Secret PIXIV_COOKIE，或访问 /diag 看各策略结果。"
        : "pixiv 返回非 JSON。";
    return json(
      {
        error: true,
        message:
          hint +
          " HTTP " +
          metaRes.status +
          "：" +
          metaText.slice(0, 120).replace(/\s+/g, " "),
      },
      502
    );
  }

  if (meta.error) {
    const gone = metaRes.status === 404;
    return json(
      { error: true, message: meta.message || "作品不存在或已删除", notFound: gone },
      gone ? 404 : 200
    );
  }

  // /pages 失败不影响主体信息，只是没有图片地址
  let pages = [];
  let regulars = [];
  let smalls = [];
  try {
    const pagesText = await pagesRes.text();
    const pagesJson = JSON.parse(pagesText);
    if (!pagesJson.error && Array.isArray(pagesJson.body)) {
      for (const p of pagesJson.body) {
        const u = p.urls || {};
        pages.push(u.original || "");
        regulars.push(u.regular || "");
        smalls.push(u.small || "");
      }
    }
  } catch {
    /* 静默降级 */
  }

  const b = meta.body || {};

  return json(
    {
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
    200,
    { "Cache-Control": "public, max-age=180" }
  );
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

  const headers = {
    Referer: "https://www.pixiv.net/",
    "User-Agent": UA,
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  };
  const ck = filterCookie(env && env.PIXIV_COOKIE);
  if (ck) headers["Cookie"] = ck;

  let res;
  try {
    res = await fetch(target.toString(), {
      headers,
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

/** 一次性把所有上游策略从当前 CF 出口试一遍，用于定位 403 的真实原因。 */
async function diag(pid, env, request) {
  const raw = (env && env.PIXIV_COOKIE) || "";
  const { kept, dropped } = splitCookie(raw);
  const filtered = kept.join("; ");

  const url = `https://www.pixiv.net/ajax/illust/${pid}/pages`;
  const variants = [
    { name: "no-cookie / desktopUA", ua: UA, cookie: "" },
    { name: "cookie(过滤后) / desktopUA", ua: UA, cookie: filtered },
    { name: "cookie(原始串) / desktopUA", ua: UA, cookie: raw },
    { name: "cookie(过滤后) / mobileUA", ua: MOBILE_UA, cookie: filtered },
  ];

  const results = [];
  for (const v of variants) {
    const h = {
      "User-Agent": v.ua,
      Referer: "https://www.pixiv.net/",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "ja,en;q=0.8",
    };
    if (v.cookie) h["Cookie"] = v.cookie;
    try {
      const r = await fetch(url, { headers: h });
      const t = await r.text();
      let isJson = false;
      try {
        isJson = Array.isArray(JSON.parse(t).body);
      } catch {}
      results.push({
        variant: v.name,
        status: r.status,
        pixivJson: isJson,
        head: t.slice(0, 70).replace(/\s+/g, " "),
      });
    } catch (e) {
      results.push({ variant: v.name, status: 0, error: String(e.message).slice(0, 90) });
    }
  }

  // 另一个主机：无 token 预期 400/401，只看是否也被 IP 拦
  try {
    const r = await fetch(
      `https://app-api.pixiv.net/v1/illust/detail?illust_id=${pid}`,
      {
        headers: {
          "User-Agent": MOBILE_UA,
          "App-OS": "android",
          "App-OS-Version": "11.0",
          "App-Version": "5.0.234",
        },
      }
    );
    results.push({
      variant: "app-api.pixiv.net（无 token）",
      status: r.status,
      head: (await r.text()).slice(0, 70).replace(/\s+/g, " "),
    });
  } catch (e) {
    results.push({ variant: "app-api.pixiv.net（无 token）", status: 0, error: String(e.message).slice(0, 90) });
  }

  return json({
    error: false,
    pid,
    colo: (request.cf && request.cf.colo) || "?",
    cookieConfigured: !!raw,
    cookieKeysKept: kept.map((s) => s.slice(0, s.indexOf("="))),
    cookieKeysDropped: dropped,
    results,
  });
}

export default {
  async fetch(request, env) {
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
        cookie: env && env.PIXIV_COOKIE ? "已配置" : "未配置",
      });
    }

    if (url.pathname === "/diag") {
      const pid = (url.searchParams.get("pid") || "115282819").replace(/\D/g, "");
      return diag(pid, env, request);
    }

    const m = url.pathname.match(/^\/api\/illust\/(\d{1,12})$/);
    if (m) return apiIllust(m[1], env);

    if (url.pathname === "/img") {
      return proxyImage(url.searchParams.get("u"), env);
    }

    return json({ error: true, message: "未知路由：" + url.pathname }, 404);
  },
};
