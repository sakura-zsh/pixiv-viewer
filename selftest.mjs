// 本地端到端自检：用 Node 起一个等价服务，跑 worker.js 的真实逻辑
// 用法：node selftest.mjs
import http from "node:http";
import worker from "./worker.js";

const PORT = 8899;

const server = http.createServer(async (req, res) => {
  try {
    const request = new Request("http://localhost" + req.url, {
      method: req.method,
      headers: req.headers,
    });
    const response = await worker.fetch(request, {});
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    if (response.body) {
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } else {
      res.end();
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("selftest error: " + e.message);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("selftest listening on http://127.0.0.1:" + PORT);
});
