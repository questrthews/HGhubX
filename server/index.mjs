import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { edge, playback, BASE } from "./catalog.mjs";
import { request } from "./network.mjs";
import { Library } from "./library.mjs";
import { Translator } from "./translation.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(
  process.env.HGHUB_DATA || path.join(os.homedir(), "HGhubX-Library"),
);
fs.mkdirSync(dir, { recursive: true });
const host = process.env.HGHUB_HOST || "127.0.0.1",
  port = Number(process.env.HGHUB_PORT || 17651);
const tls = process.env.HGHUB_TLS_CERT && process.env.HGHUB_TLS_KEY;
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw Error("Invalid HGHUB_PORT");
if (process.env.HGHUB_QUOTA_GB && !(Number(process.env.HGHUB_QUOTA_GB) > 0))
  throw Error("HGHUB_QUOTA_GB must be positive");
const authFile = path.join(dir, "access.json");
let auth;
try {
  auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
} catch {
  const password = crypto.randomBytes(18).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  auth = { salt, hash: crypto.scryptSync(password, salt, 32).toString("hex") };
  fs.writeFileSync(authFile, JSON.stringify(auth), { mode: 0o600 });
  console.log(`First-run access password (save it): ${password}`);
}
const sessions = new Map(),
  failures = new Map();
const mediaTokens = new Map();
let upstreamToken = "",
  upstreamUser = null;
const stateFile = path.join(dir, "state.json");
let state = {
  likes: [],
  favs: [],
  history: [],
  follows: [],
  searchHist: [],
  blockedTags: [],
  blockedCreators: [],
  hideWatched: false,
};
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
} catch {}
const translator = new Translator(dir);
const library = new Library(path.join(dir, "downloads"), {
  quotaGB: Number(process.env.HGHUB_QUOTA_GB || 20),
  minFreeGB: 1,
  ffmpeg: process.env.HGHUB_FFMPEG || "ffmpeg",
});
const mediaKey = () => {
  for (const [key, expiry] of mediaTokens)
    if (expiry < Date.now()) mediaTokens.delete(key);
  if (mediaTokens.size >= 2000)
    mediaTokens.delete(mediaTokens.keys().next().value);
  const k = crypto.randomBytes(24).toString("hex");
  mediaTokens.set(k, Date.now() + 24 * 3600000);
  return k;
};
function json(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
async function body(req, max = 128 * 1024) {
  let n = 0,
    parts = [];
  for await (const c of req) {
    n += c.length;
    if (n > max) throw Error("Request too large");
    parts.push(c);
  }
  return JSON.parse(Buffer.concat(parts).toString() || "{}");
}
function authorized(req) {
  const id = /\bhghub=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];
  return id && sessions.get(id) > Date.now();
}
function sameOrigin(req) {
  return (
    !req.headers.origin ||
    req.headers.origin === `${tls ? "https" : "http"}://${req.headers.host}`
  );
}
function number(v, def = 1, max = 100000000) {
  const n = Number(v ?? def);
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw Error("Invalid numeric argument");
  return n;
}
async function catalog(a) {
  const page = number(a.page, 1, 10000),
    size = number(a.size, 20, 100),
    id = a.id === undefined ? 0 : number(a.id);
  const e = encodeURIComponent;
  const q = `page=${page}&size=${size}`;
  const sort = a.sort ? `&sort=${e(a.sort)}` : "";
  let p;
  switch (a.action) {
    case "feed":
      p = `/api/videos?${q}`;
      break;
    case "search":
      p = `/api/search?q=${e(String(a.q || "").slice(0, 200))}&type=video&${q}`;
      break;
    case "category":
      p = `/api/videos/category/${e(a.cate)}?${q}${sort}`;
      break;
    case "tags":
      p = "/api/tags";
      break;
    case "tag":
      p = `/api/videos/tag/${e(a.tag)}?${q}`;
      break;
    case "rank":
      p = `/api/ranks/${["hot", "recommend", "potential"].includes(a.kind) ? a.kind : "hot"}`;
      break;
    case "detail":
      p = `/api/videos/${id}`;
      break;
    case "related":
      p = `/api/videos/${id}/related`;
      break;
    case "play":
      return playback(id, number(a.ep), upstreamToken);
    case "login": {
      const v = await edge("/api/account/loginByPassword", "POST", {
        username: String(a.username || "").slice(0, 200),
        password: String(a.password || "").slice(0, 500),
      });
      upstreamToken = v.token;
      upstreamUser = v.user;
      return { user: upstreamUser };
    }
    case "logout":
      upstreamToken = "";
      upstreamUser = null;
      return { ok: true };
    default:
      throw Error("Unsupported catalog action");
  }
  return edge(p, "GET", null, upstreamToken);
}
async function serveFile(req, res, file, type) {
  const st = fs.statSync(file);
  const range = req.headers.range;
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, no-store");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start, end;
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      res.end();
      return;
    }
    if (!m[1]) {
      start = Math.max(0, st.size - Number(m[2]));
      end = st.size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    }
    if (!Number.isSafeInteger(start) || start > end || start >= st.size) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${st.size}`,
      "Content-Length": end - start + 1,
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": st.size });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
  }
}
function proxyURL(raw, key, base) {
  return `/media?key=${key}&u=${encodeURIComponent(new URL(raw, base).href)}`;
}
async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  const u = new URL(req.url, "http://localhost");
  try {
    if (!["GET", "HEAD", "POST", "DELETE"].includes(req.method))
      return json(res, 405, { error: "Method not allowed" });
    if (!sameOrigin(req))
      return json(res, 403, { error: "Cross-origin request blocked" });
    if (u.pathname === "/auth" && req.method === "POST") {
      const ip = req.socket.remoteAddress;
      const now = Date.now();
      for (const [k, v] of failures)
        if (now - v.at > 600000) failures.delete(k);
      const f = failures.get(ip) || { n: 0, at: now };
      if (f.n >= 10)
        return json(res, 429, { error: "Too many attempts; wait ten minutes" });
      const a = await body(req, 4096);
      const h = crypto.scryptSync(
        String(a.password || "").slice(0, 500),
        auth.salt,
        32,
      );
      if (!crypto.timingSafeEqual(h, Buffer.from(auth.hash, "hex"))) {
        f.n++;
        failures.set(ip, f);
        return json(res, 401, { error: "Incorrect access password" });
      }
      failures.delete(ip);
      for (const [k, v] of sessions) if (v < now) sessions.delete(k);
      const key = crypto.randomBytes(32).toString("hex");
      sessions.set(key, now + 24 * 3600000);
      res.setHeader(
        "Set-Cookie",
        `hghub=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${tls ? "; Secure" : ""}`,
      );
      return json(res, 200, { ok: true });
    }
    if (
      u.pathname.startsWith("/api/") ||
      u.pathname === "/media" ||
      u.pathname.startsWith("/offline/")
    ) {
      const token = u.searchParams.get("key");
      const mediaAuth = token && mediaTokens.get(token) > Date.now();
      if (!authorized(req) && !(u.pathname === "/media" && mediaAuth))
        return json(res, 401, {
          error: "Sign in with the access password shown on the Windows server",
        });
      if (u.pathname === "/api/status" && req.method === "GET")
        return json(res, 200, {
          translation: translator.status(),
          quotaGB: library.quota / 1024 ** 3,
          used: library.used(),
          user: upstreamUser,
        });
      if (u.pathname === "/api/catalog" && req.method === "POST")
        return json(res, 200, await catalog(await body(req)));
      if (u.pathname === "/api/translate" && req.method === "POST") {
        const a = await body(req);
        return json(res, 200, {
          text: await translator.translate(
            a.text,
            a.language === "Chinese" ? "Chinese" : "English",
          ),
        });
      }
      if (u.pathname === "/api/state") {
        if (req.method === "POST") {
          const a = await body(req); // Patch individual preferences, merge watch progress by video and timestamp.
          for (const key of [
            "likes",
            "favs",
            "follows",
            "searchHist",
            "blockedTags",
            "blockedCreators",
          ])
            if (Array.isArray(a[key]))
              state[key] = a[key]
                .filter((x) => typeof x === "string" || typeof x === "number")
                .slice(0, 1000);
          if (typeof a.hideWatched === "boolean")
            state.hideWatched = a.hideWatched;
          if (Array.isArray(a.history)) {
            const map = new Map(state.history.map((h) => [h.id, h]));
            for (const h of a.history)
              if (
                Number.isSafeInteger(h.id) &&
                h.id > 0 &&
                Number.isFinite(h.t) &&
                h.t >= 0 &&
                Number.isSafeInteger(h.ep) &&
                h.ep > 0
              ) {
                const old = map.get(h.id);
                if (!old || Number(h.at) > old.at)
                  map.set(h.id, {
                    id: h.id,
                    ep: h.ep,
                    t: h.t,
                    dur: Number(h.dur) || 0,
                    at: Math.min(Number(h.at) || 0, Date.now()),
                  });
              }
            state.history = [...map.values()]
              .sort((a, b) => b.at - a.at)
              .slice(0, 1000);
          }
          fs.writeFileSync(stateFile + ".tmp", JSON.stringify(state));
          fs.renameSync(stateFile + ".tmp", stateFile);
        } else if (req.method !== "GET")
          return json(res, 405, { error: "Method not allowed" });
        return json(res, 200, state);
      }
      if (u.pathname === "/api/downloads") {
        if (req.method === "POST") {
          const a = await body(req);
          const j = library.add(a);
          void library.pump((id, ep) => playback(id, ep, upstreamToken));
          return json(res, 200, j);
        }
        if (req.method === "GET") return json(res, 200, library.jobs);
      }
      const job = /^\/api\/downloads\/([a-f0-9-]+)(\/cancel)?$/.exec(
        u.pathname,
      );
      if (job) {
        if (job[2] && req.method === "POST") library.cancel(job[1]);
        else if (!job[2] && req.method === "DELETE") library.remove(job[1]);
        else return json(res, 405, { error: "Method not allowed" });
        return json(res, 200, { ok: true });
      }
      const offline = /^\/offline\/([a-f0-9-]+)$/.exec(u.pathname);
      if (offline && ["GET", "HEAD"].includes(req.method)) {
        if (
          !library.jobs.some(
            (j) => j.key === offline[1] && j.status === "complete",
          )
        )
          throw Error("Download not found");
        return serveFile(
          req,
          res,
          path.join(library.dir, offline[1], "video.mp4"),
          "video/mp4",
        );
      }
      if (u.pathname === "/api/media-key" && req.method === "POST")
        return json(res, 200, { key: mediaKey() });
      if (u.pathname === "/media" && req.method === "GET") {
        const key = mediaAuth ? token : mediaKey();
        const r = await request(u.searchParams.get("u"), {
          max: 64 * 1024 * 1024,
          headers: { Referer: BASE + "/" },
        });
        let bytes = r.bytes,
          type = r.type;
        if (
          bytes.subarray(0, 200).toString().trimStart().startsWith("#EXTM3U")
        ) {
          let text = bytes.toString();
          if (/METHOD=SAMPLE-AES|KEYFORMAT="(?!identity)/.test(text))
            throw Error("Protected playback is unsupported");
          text = text
            .split(/\r?\n/)
            .map((l) =>
              l.startsWith("#")
                ? l.replace(/(?:SERVER-)?URI="([^"]+)"/g, (match, uri) =>
                    match.replace(uri, proxyURL(uri, key, r.url)),
                  )
                : l.trim()
                  ? proxyURL(l.trim(), key, r.url)
                  : l,
            )
            .join("\n");
          bytes = Buffer.from(text);
          type = "application/vnd.apple.mpegurl";
        } else if (u.searchParams.get("image") === "1") {
          if (
            !/^(image\/)/.test(type) ||
            !/^\xff\xd8|^\x89PNG|^GIF8|^RIFF/.test(
              bytes.subarray(0, 12).toString("latin1"),
            )
          ) {
            try {
              const d = crypto.createDecipheriv(
                "aes-128-cbc",
                Buffer.from("f5d965df75336270"),
                Buffer.from("97b60394abc2fbe1"),
              );
              bytes = Buffer.concat([d.update(bytes), d.final()]);
            } catch {
              throw Error("Invalid cover image");
            }
          }
          type =
            bytes[0] === 255
              ? "image/jpeg"
              : bytes[0] === 137
                ? "image/png"
                : bytes.subarray(0, 4).toString() === "GIF8"
                  ? "image/gif"
                  : "image/webp";
        }
        res.writeHead(200, {
          "Content-Type": type || "application/octet-stream",
          "Content-Length": bytes.length,
          "Cache-Control": "private, max-age=60",
        });
        res.end(bytes);
        return;
      }
      return json(res, 404, { error: "Not found" });
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return json(res, 405, { error: "Method not allowed" });
    const file = path.resolve(
      root,
      "dist-web",
      "." + decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname),
    );
    if (
      !file.startsWith(path.join(root, "dist-web") + path.sep) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    )
      return json(res, 404, {
        error: "Build the web interface with npm run web:build",
      });
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    const mime = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    return serveFile(
      req,
      res,
      file,
      mime[path.extname(file)] || "application/octet-stream",
    );
  } catch (e) {
    if (!res.headersSent)
      json(res, 400, { error: e.message || "Request failed" });
    else res.destroy();
  }
}
const server = tls
  ? https.createServer(
      {
        cert: fs.readFileSync(process.env.HGHUB_TLS_CERT),
        key: fs.readFileSync(process.env.HGHUB_TLS_KEY),
      },
      handler,
    )
  : http.createServer(handler);
server.requestTimeout = 120000;
server.headersTimeout = 10000;
server.maxHeadersCount = 50;
server.listen(port, host, () =>
  console.log(
    `HGhubX English: ${tls ? "https" : "http"}://${host}:${server.address().port}\nData: ${dir}\nFor iPad: set HGHUB_HOST=0.0.0.0 and open this PC's LAN IP. Prefer HTTPS on shared networks.`,
  ),
);
