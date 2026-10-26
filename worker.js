/**
 * Pixiv 作品查看器 · Cloudflare Worker 后端
 *
 * 路由：
 *   GET /api/illust/{pid}   → 作品元数据 + 每页图片地址
 *   GET /img?u={pximg URL}  → 代理 i.pximg.net（补上伪装 Referer，绕开防盗链）
 *   GET /health             → 健康检查
 *
 * 关键实现说明（都是实测结论，别随手改）：
 *   1. /ajax/illust/{pid} 在未登录时 urls 全为 null，拿不到图片地址。
 *   2. /ajax/illust/{pid}/pages 未登录也能返回完整 URL —— 图片地址必须走这个接口。
 *   3. 不能用 uploadDate 自己推算路径：uploadDate 只精确到分钟，
 *      而 pximg 路径是秒级上传时间，实测差了 31 秒。
 *   4. i.pximg.net 强制校验 Referer：空 Referer 和第三方 Referer 都是 403，
 *      必须带 https://www.pixiv.net/ 才能 200。所以图片必须经本 Worker 转发。
 *
 * 可选 Secret：
 *   PIXIV_COOKIE —— 若你的出口 IP 被 pixiv 风控（返回 403 或非 JSON），
 *                   填浏览器里 pixiv 的完整 Cookie 串可缓解。
 *
 * 部署：Cloudflare Dashboard → Workers & Pages → Create Worker → 粘贴本文件 → Deploy
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

function pixivHeaders(env) {
  const h = {
    "User-Agent": UA,
    Referer: "https://www.pixiv.net/",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
  };
  if (env && env.PIXIV_COOKIE) h["Cookie"] = env.PIXIV_COOKIE;
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
    return json(
      {
        error: true,
        message:
          "pixiv 返回非 JSON（可能被风控）。HTTP " +
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
  if (env && env.PIXIV_COOKIE) headers["Cookie"] = env.PIXIV_COOKIE;

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
        routes: ["GET /api/illust/{pid}", "GET /img?u={i.pximg.net URL}"],
        cookie: env && env.PIXIV_COOKIE ? "已配置" : "未配置",
      });
    }

    const m = url.pathname.match(/^\/api\/illust\/(\d{1,12})$/);
    if (m) return apiIllust(m[1], env);

    if (url.pathname === "/img") {
      return proxyImage(url.searchParams.get("u"), env);
    }

    return json({ error: true, message: "未知路由：" + url.pathname }, 404);
  },
};
