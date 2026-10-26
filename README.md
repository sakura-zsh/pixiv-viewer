# Pixiv 作品查看器

输入作品 ID 就能看图的小工具。单文件静态页 + 一个 Cloudflare Worker 后端。

## 为什么必须有后端

不是设计冗余，是 pixiv 的硬性限制，实测结论：

| 事实 | 后果 |
|---|---|
| `i.pximg.net` 强制校验 `Referer` | 空 Referer 和第三方 Referer **都是 403**，只有 `https://www.pixiv.net/` 才给图 |
| 浏览器无法伪造 Referer | 所以 `<img src="i.pximg.net/...">` 必然失败，纯静态**做不到** |
| `/ajax/illust/{pid}` 未登录时 `urls` 全为 `null` | 拿不到图片地址 |
| `/ajax/illust/{pid}/pages` 未登录**能拿到**完整地址 | 图片地址必须走这个接口 |
| `uploadDate` 只精确到分钟，`pximg` 路径是秒级上传时间 | 实测差 31 秒，**不能自己推算路径** |
| CF Worker 出口访问 `*.pixiv.net` 一律 **403** | 是 pixiv 边缘层按机房 IP 整域拦截，不是 cookie 问题（`app-api` 也 403） |
| 同一出口访问 `i.pximg.net` **正常 200** | 图床和 API 分属不同边缘，只有 API 被封 |

所以 Worker 至少要负责转发图片。元数据有两条路，前端会自动择路：

1. **Worker `/api/illust`**（直连 pixiv，被拒则内部降级到中继）——带 10 分钟缓存，最快
2. **浏览器直连 `r.jina.ai` 中继** —— `r.jina.ai` 会回显 Origin 放行 CORS，所以浏览器能直接读到 pixiv 的原始 JSON

**这意味着 Worker 只需要能转发图片即可，旧版本也能用**。前端在 Worker 元数据接口失败时会自动切到第 2 条，功能不受影响。

图片不吃中继额度，始终由 Worker 带伪装 Referer 直接取。

## 部署

### 1. 后端（Cloudflare Worker）

**方式 A：Dashboard 粘贴（最快）**

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Worker**
2. 名字随意，创建后点 **Edit code**
3. 把 `worker.js` 的内容整个粘进去，覆盖模板
4. **Deploy**，记下分配到的地址，形如 `https://pixiv-viewer.你的子域.workers.dev`

**方式 B：wrangler 一条命令**

```bash
npx wrangler deploy
```

仓库里已有 `wrangler.toml`，无需额外配置。

可选：给 Worker 加一个 Secret `JINA_KEY`（[jina.ai/reader](https://jina.ai/reader) 免费申请）。

不加也能跑，但中继免费额度是 **20 次/分**，API 结果缓存 10 分钟；加上可提到 200 次/分。

```bash
npx wrangler secret put JINA_KEY
```

> `PIXIV_COOKIE` 那条老办法**没用**，别试了。实测带 cookie、不带 cookie、原始串、
> 移动端 UA 四种策略在 CF 出口全是 403，连不看 cookie 的 `app-api.pixiv.net` 也是 403。

### 2. 前端（任选其一）

**GitHub Pages**

```bash
git clone <本仓库>
cd pixiv-viewer
git push   # 推到你的仓库
```

仓库 Settings → Pages → Source 选 `main` 分支根目录 → 保存。地址为 `https://<用户名>.github.io/<仓库名>/`。

**Cloudflare Pages**：连仓库，构建命令留空，输出目录填 `/`。

**任意静态托管**：把 `index.html` 单文件扔上去即可，无依赖、无构建。

### 3. 绑定后端

打开页面 → 右上角 **⚙** → 填入 Worker 地址 → 保存。

地址存在 `localStorage`，也可以用 URL 参数免配置：

```
https://你的域名/?api=https://xxx.workers.dev&q=115282819
```

## 用法

输入框支持四种写法：

```
82775556                                   纯作品 ID
115282819-2                                多图作品第 2 张
https://www.pixiv.net/artworks/115282819   pixiv 链接
115282819:1                                旧格式（兼容）
```

多图作品用 `←` `→` 翻页，或点底部缩略图。默认显示 1200px 预览图，点「查看原图」切到原图。

## 已知限制

- **必须能访问 `workers.dev`**。大陆网络环境下这个域名经常不可用，建议给 Worker 绑自定义域名，或走代理。
- **动图（うごイラ）不支持**，只显示首帧。
- **元数据依赖 `r.jina.ai`**。免费额度 20 次/分，超出会返回 429；结果缓存 10 分钟，正常个人使用碰不到上限。走 Worker 主通道时缓存更省额度。
- **首次查询约 1 秒**（中继往返），命中缓存后是毫秒级。
- Worker 免费额度是每天 10 万次请求，个人用绰绰有余。图片走 Cloudflare 缓存，重复查看不消耗回源。
- **VPS 中转这条路走不通**：国内机房到 pixiv 是 IP 层 TCP 封锁（`210.140.131.x:443` 全 CLOSED），连 `r.jina.ai` 都超时。别指望用自建服务器绕过。

## 本地调试

仓库里的 `selftest.mjs` 用 Node 直接跑 `worker.js` 的逻辑，不依赖 Cloudflare：

```bash
node selftest.mjs
# 另开终端
curl "http://127.0.0.1:8899/api/illust/115282819"
```

配合任意静态服务器即可本地预览整页。

## 目录

```
index.html     页面（单文件，含全部样式与脚本）
worker.js      Cloudflare Worker 后端
selftest.mjs   本地自检服务（调试用，不需要部署）
```
