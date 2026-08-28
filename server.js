// 单词花园服务端。跑在家里的 Mac mini 上，家里任何设备用浏览器打开都是同一个单词本。
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./lib/store.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const MAX_BODY = 15 * 1024 * 1024; // 手机照片压过再传，15MB 足够

// 读 .env（不引依赖，够用就行）
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* 没有 .env 就算了，AI 功能会给出提示 */ }

// ai.js 里会 new Anthropic()，没 key 时构造就会抛，所以延迟到用的时候再 import
let ai = null;
async function getAI() {
  if (!ai) ai = await import("./lib/ai.js");
  return ai;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("照片太大了"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("请求格式不对"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: "禁止访问" });
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      // 开发期不缓存，改了刷新就能看到
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("没有这个页面");
  }
}

// 前端传上来的 dataURL / 纯 base64 都接受
function parseImage(input) {
  if (typeof input !== "string" || !input) throw Object.assign(new Error("没有收到照片"), { status: 400 });
  const m = input.match(/^data:(image\/[a-z+]+);base64,(.*)$/s);
  if (m) return { mediaType: m[1], base64: m[2] };
  return { mediaType: "image/jpeg", base64: input };
}

function aiUnavailable(res) {
  return sendJSON(res, 503, {
    error: "还没配 API key",
    hint: "把 .env.example 复制成 .env，填上 ANTHROPIC_API_KEY，然后重启一下服务。",
  });
}

const routes = {
  "GET /api/state": async (req, res, { profileId }) => {
    sendJSON(res, 200, { ...store.snapshot(profileId), aiReady: hasKeySync() });
  },

  "POST /api/lookup": async (req, res, { body }) => {
    if (!hasKeySync()) return aiUnavailable(res);
    const query = String(body.query || "").trim();
    if (!query) return sendJSON(res, 400, { error: "先说一个词吧" });
    const { lookup } = await getAI();
    sendJSON(res, 200, await lookup(query));
  },

  "POST /api/vision": async (req, res, { body }) => {
    if (!hasKeySync()) return aiUnavailable(res);
    const { base64, mediaType } = parseImage(body.image);
    const { identifyPhoto } = await getAI();
    sendJSON(res, 200, { items: await identifyPhoto(base64, mediaType) });
  },

  "POST /api/ocr": async (req, res, { body }) => {
    if (!hasKeySync()) return aiUnavailable(res);
    const { base64, mediaType } = parseImage(body.image);
    const { readWordList } = await getAI();
    sendJSON(res, 200, { items: await readWordList(base64, mediaType) });
  },

  // 收下单词。带照片的话先把照片存成文件，再把路径挂到第一个词上。
  "POST /api/collect": async (req, res, { profileId, body }) => {
    const items = Array.isArray(body.items) ? body.items : [body.item].filter(Boolean);
    if (!items.length) return sendJSON(res, 400, { error: "没有要收的词" });
    if (body.photo) {
      const { base64, mediaType } = parseImage(body.photo);
      items[0] = { ...items[0], photo: await store.savePhoto(base64, mediaType.split("/")[1]) };
    }
    const { added, skipped } = await store.addWords(profileId, items, body.source);
    sendJSON(res, 200, { added, skipped, words: store.listWords(profileId) });
  },

  "POST /api/review": async (req, res, { profileId, body }) => {
    const word = await store.reviewWord(profileId, body.id, !!body.correct, !!body.hesitated);
    if (!word) return sendJSON(res, 404, { error: "找不到这个词" });
    sendJSON(res, 200, { word });
  },

  "POST /api/forget": async (req, res, { profileId, body }) => {
    const ok = await store.removeWord(profileId, body.id);
    sendJSON(res, ok ? 200 : 404, ok ? { ok } : { error: "找不到这个词" });
  },
};

function hasKeySync() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith("/photos/")) {
      const data = await fsp.readFile(store.photoPath(pathname.slice("/photos/".length)));
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=31536000" });
      return res.end(data);
    }

    if (pathname.startsWith("/api/")) {
      const handler = routes[`${req.method} ${pathname}`];
      if (!handler) return sendJSON(res, 404, { error: "没有这个接口" });
      const body = req.method === "GET" ? {} : await readBody(req);
      const profileId = body.profileId || url.searchParams.get("profile") || "p1";
      return await handler(req, res, { profileId, body });
    }

    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error("[出错]", err);
    if (res.headersSent) return res.end();
    sendJSON(res, err.status || 500, {
      error: err.message || "服务器出了点问题",
    });
  }
});

const PORT = Number(process.env.PORT) || 5173;
await store.init();
server.listen(PORT, () => {
  console.log(`🌱 单词花园跑起来了：http://localhost:${PORT}`);
  if (!hasKeySync()) {
    console.log("⚠️  还没配 ANTHROPIC_API_KEY，查词和拍照功能会提示配置；单词本和复习不受影响。");
  }
});
