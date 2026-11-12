import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Library } from "./library.mjs";
test("downloads an HLS fixture and remuxes to a playable MP4 without network access", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
    t.skip("FFmpeg is required");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hghub-hls-"));
  try {
    const fixture = path.join(dir, "fixture");
    fs.mkdirSync(fixture);
    const generated = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x120:r=10",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "0",
      path.join(fixture, "index.m3u8"),
    ]);
    assert.equal(generated.status, 0, generated.stderr.toString());
    const lib = new Library(path.join(dir, "library"), {
      minFreeGB: 0,
      fetchResource: async (raw, opts) => {
        const u = new URL(raw);
        const bytes = fs.readFileSync(
          path.join(fixture, path.basename(u.pathname)),
        );
        opts.onChunk?.(bytes);
        return {
          url: u.href,
          bytes,
          type: u.pathname.endsWith("m3u8")
            ? "application/vnd.apple.mpegurl"
            : "video/mp2t",
        };
      },
    });
    const j = lib.add({ id: 1, ep: 1, title: "Fixture" });
    await lib.pump(async () => ({
      video_url: "https://fixture.example/index.m3u8",
    }));
    assert.equal(j.status, "complete", j.error);
    assert.equal(j.progress, 100);
    const mp4 = path.join(lib.dir, j.key, "video.mp4");
    assert.ok(fs.statSync(mp4).size > 1000);
    assert.deepEqual(fs.readdirSync(path.dirname(mp4)), ["video.mp4"]);
    const probe = spawnSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      mp4,
    ]);
    assert.equal(probe.status, 0);
    assert.ok(Number(probe.stdout.toString()) >= 1.9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("rejects unsafe or unsupported playlist layouts and removes partial files", async () => {
  for (const text of [
    "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=file:///secret\nseg.ts\n#EXT-X-ENDLIST",
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\nseg.ts\n#EXT-X-ENDLIST',
    "#EXTM3U\n#EXT-X-BYTERANGE:5@0\nseg.ts\n#EXT-X-ENDLIST",
    "#EXTM3U\nseg.ts",
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hghub-invalid-"));
    try {
      const lib = new Library(dir, {
        minFreeGB: 0,
        fetchResource: async (raw) => ({ url: raw, bytes: Buffer.from(text) }),
      });
      const j = lib.add({ id: 1, ep: 1 });
      await lib.pump(async () => ({
        video_url: "https://fixture.example/index.m3u8",
      }));
      assert.equal(j.status, "failed");
      assert.equal(fs.existsSync(path.join(dir, j.key)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
