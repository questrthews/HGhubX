import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { request } from "./network.mjs";
export class Library {
  constructor(
    dir,
    {
      quotaGB = 20,
      minFreeGB = 1,
      ffmpeg = "ffmpeg",
      fetchResource = request,
    } = {},
  ) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "library.json");
    this.quota = quotaGB * 1024 ** 3;
    this.minFree = minFreeGB * 1024 ** 3;
    this.ffmpeg = ffmpeg;
    this.fetchResource = fetchResource;
    this.jobs = [];
    this.active = null;
    try {
      this.jobs = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {}
    for (const j of this.jobs)
      if (["queued", "downloading", "converting"].includes(j.status)) {
        j.status = "failed";
        j.error = "Server restarted; retry this download";
      }
    this.save();
  }
  save() {
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.jobs));
    fs.renameSync(this.file + ".tmp", this.file);
  }
  used() {
    let n = 0;
    for (const j of this.jobs) {
      const d = path.join(this.dir, j.key);
      if (fs.existsSync(d))
        for (const f of fs.readdirSync(d))
          n += fs.statSync(path.join(d, f)).size;
    }
    return n;
  }
  room(extra = 0) {
    const s = fs.statfsSync(this.dir);
    if (
      this.used() + extra > this.quota ||
      s.bavail * s.bsize - extra < this.minFree
    )
      throw Error("Download storage limit or minimum free space reached");
  }
  add({ id, ep, title, quality = "standard" }) {
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !Number.isSafeInteger(ep) ||
      ep < 1 ||
      ep > 100000
    )
      throw Error("Invalid episode");
    if (!["standard", "hevc"].includes(quality)) throw Error("Invalid quality");
    const existing = this.jobs.find(
      (j) =>
        j.id === id &&
        j.ep === ep &&
        j.quality === quality &&
        !["failed", "cancelled"].includes(j.status),
    );
    if (existing) return existing;
    if (this.jobs.filter((j) => j.status === "queued").length >= 100)
      throw Error("Queue is full");
    this.room();
    const j = {
      key: crypto.randomUUID(),
      id,
      ep,
      title: String(title || `Video ${id}`).slice(0, 200),
      quality,
      status: "queued",
      bytes: 0,
      progress: 0,
      created: Date.now(),
    };
    this.jobs.push(j);
    this.save();
    return j;
  }
  cancel(key) {
    const j = this.jobs.find((j) => j.key === key);
    if (!j) throw Error("Download not found");
    if (j.status === "complete")
      throw Error("Use delete for completed downloads");
    j.status = "cancelled";
    if (this.active?.key === key) {
      this.active.controller.abort();
      this.active.process?.kill();
    } else
      fs.rmSync(path.join(this.dir, key), { recursive: true, force: true });
    this.save();
  }
  remove(key) {
    if (this.active?.key === key)
      throw Error("Cancel and wait before deleting");
    this.jobs = this.jobs.filter((j) => j.key !== key);
    fs.rmSync(path.join(this.dir, key), { recursive: true, force: true });
    this.save();
  }
  async pump(getPlayback) {
    if (this.active) return;
    const j = this.jobs.find((j) => j.status === "queued");
    if (!j) return;
    this.active = { key: j.key, controller: new AbortController() };
    const signal = this.active.controller.signal;
    const dir = path.join(this.dir, j.key);
    fs.mkdirSync(dir, { recursive: true });
    try {
      j.status = "downloading";
      this.save();
      const info = await getPlayback(j.id, j.ep);
      let url =
        j.quality === "hevc"
          ? info.video_url_hevc || info.video_url
          : info.video_url;
      if (!url) throw Error("No playable stream");
      const get = async (u, max = 32 * 1024 * 1024) =>
        this.fetchResource(u, {
          signal,
          max,
          headers: { Referer: "https://huangguoai.com/" },
          onChunk: (c) => {
            this.room(c.length);
            j.bytes += c.length;
          },
        });
      let response = await get(url, 2 * 1024 * 1024);
      let text = response.bytes.toString();
      if (!text.trimStart().startsWith("#EXTM3U"))
        throw Error("This download requires an HLS playlist");
      for (let depth = 0; text.includes("#EXT-X-STREAM-INF"); depth++) {
        if (depth > 3) throw Error("Playlist nesting limit");
        const lines = text.split(/\r?\n/);
        const variants = [];
        for (let i = 0; i < lines.length; i++)
          if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
            if (/AUDIO=|SUBTITLES=/.test(lines[i]))
              throw Error(
                "Separate audio/subtitle renditions are not yet supported",
              );
            const uri = lines
              .slice(i + 1)
              .find((l) => l.trim() && !l.startsWith("#"));
            if (uri)
              variants.push({
                url: new URL(uri, response.url).href,
                rate: Number(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1] || 0),
              });
          }
        variants.sort((a, b) => b.rate - a.rate);
        if (!variants[0]) throw Error("Empty master playlist");
        response = await get(variants[0].url, 2 * 1024 * 1024);
        text = response.bytes.toString();
      }
      if (!text.includes("#EXT-X-ENDLIST"))
        throw Error("Live streams cannot be downloaded");
      if (/#EXT-X-(BYTERANGE|GAP|PART|PRELOAD-HINT|SESSION-KEY)/.test(text))
        throw Error("Unsupported HLS layout");
      const lines = text.split(/\r?\n/);
      const total = lines.filter((l) => l.trim() && !l.startsWith("#")).length;
      let done = 0;
      let seq = 0;
      const resources = new Map();
      const save = async (uri, extension) => {
        const u = new URL(uri, response.url).href;
        if (resources.has(u)) return resources.get(u);
        const filename = `part-${seq++}.${extension}`;
        const r = await get(u);
        fs.writeFileSync(path.join(dir, filename), r.bytes);
        resources.set(u, filename);
        return filename;
      };
      const out = [];
      for (const line of lines) {
        if (signal.aborted) throw Error("Cancelled");
        if (line.startsWith("#EXT-X-KEY")) {
          if (
            !/METHOD=(AES-128|NONE)(?:,|$)/.test(line) ||
            (/KEYFORMAT=/.test(line) && !line.includes('KEYFORMAT="identity"'))
          )
            throw Error("Protected or unsupported encryption is not supported");
        }
        if (line.startsWith("#EXT-X-KEY") || line.startsWith("#EXT-X-MAP")) {
          const m = /URI="([^"]+)"/.exec(line);
          if (!m && !/^#EXT-X-KEY:METHOD=NONE\s*$/.test(line))
            throw Error("Unsupported playlist resource URI");
          out.push(
            m
              ? line.replace(
                  m[0],
                  `URI="${await save(m[1], line.startsWith("#EXT-X-KEY") ? "key" : "mp4")}"`,
                )
              : line,
          );
        } else if (line.trim() && !line.startsWith("#")) {
          out.push(await save(line.trim(), "ts"));
          j.progress = Math.round((++done / Math.max(1, total)) * 90);
          this.save();
        } else if (line.startsWith("#EXT") && /URI=|SERVER-URI=/.test(line))
          throw Error("Unsupported external playlist resource");
        else out.push(line);
      }
      fs.writeFileSync(path.join(dir, "local.m3u8"), out.join("\n"));
      j.status = "converting";
      this.save();
      this.room(j.bytes);
      await new Promise((resolve, reject) => {
        const child = spawn(
          this.ffmpeg,
          [
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,crypto,data",
            "-allowed_extensions",
            "ALL",
            "-i",
            path.join(dir, "local.m3u8"),
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-n",
            path.join(dir, "video.mp4"),
          ],
          { windowsHide: true },
        );
        this.active.process = child;
        let error = "";
        child.stderr.on("data", (b) => {
          error = (error + b.toString()).slice(-1000);
        });
        child.on("error", () =>
          reject(Error("FFmpeg was not found. Install it and add it to PATH.")),
        );
        child.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(Error(error || "Conversion cancelled or failed")),
        );
      });
      if (signal.aborted) throw Error("Cancelled");
      for (const f of fs.readdirSync(dir))
        if (f !== "video.mp4") fs.rmSync(path.join(dir, f));
      j.status = "complete";
      j.progress = 100;
      j.bytes = fs.statSync(path.join(dir, "video.mp4")).size;
    } catch (e) {
      if (j.status !== "cancelled") {
        j.status = "failed";
        j.error = e.message;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      this.active = null;
      this.save();
      setImmediate(() => this.pump(getPlayback));
    }
  }
}
