import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { publicIP, target } from "./network.mjs";
import { Library } from "./library.mjs";
import { Translator } from "./translation.mjs";
test("blocks local, reserved and alternate address encodings", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "2002:c0a8:101::",
    "2001:db8::1",
    "2001:2::1",
    "2001:0010::1",
  ])
    assert.equal(publicIP(ip), false, ip);
  for (const url of [
    "http://example.com",
    "https://127.1",
    "https://2130706433",
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "https://example.com:8443",
  ])
    await assert.rejects(target(url));
  assert.equal(publicIP("1.1.1.1"), true);
  assert.equal(publicIP("2606:4700:4700::1111"), true);
});
test("queue deduplicates, validates, cancels and recovers interrupted jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hghub-queue-"));
  try {
    const lib = new Library(dir, { minFreeGB: 0 });
    const j = lib.add({ id: 1, ep: 1, title: "Example" });
    assert.equal(lib.add({ id: 1, ep: 1, title: "Same" }).key, j.key);
    assert.throws(() => lib.add({ id: "../../bad", ep: 1 }));
    assert.throws(() => lib.add({ id: 1, ep: 1, quality: "bad" }));
    lib.cancel(j.key);
    assert.equal(j.status, "cancelled");
    const j2 = lib.add({ id: 1, ep: 1 });
    assert.notEqual(j2.key, j.key);
    const recovered = new Library(dir, { minFreeGB: 0 });
    assert.equal(recovered.jobs.find((x) => x.key === j2.key).status, "failed");
    lib.remove(j.key);
    assert.equal(lib.jobs.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("failed download cleans files; cancellation aborts the active fetch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hghub-cancel-"));
  try {
    const lib = new Library(dir, { minFreeGB: 0 });
    const j = lib.add({ id: 5, ep: 1 });
    await lib.pump(async () => ({ video_url: "https://127.0.0.1/x" }));
    assert.equal(j.status, "failed");
    assert.equal(fs.existsSync(path.join(dir, j.key)), false);
    const k = lib.add({ id: 5, ep: 2 });
    let release;
    const wait = new Promise((r) => (release = r));
    const run = lib.pump(async () => {
      await wait;
      return { video_url: "https://127.0.0.1/x" };
    });
    lib.cancel(k.key);
    release();
    await run;
    assert.equal(k.status, "cancelled");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("translation is explicit and English passthrough needs no provider", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hghub-text-"));
  try {
    const t = new Translator(dir, {});
    assert.equal(await t.translate("English title"), "English title");
    await assert.rejects(t.translate("中文"));
    assert.equal(t.status().configured, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP auth, CSRF, state merge and media protections", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hghub-http-"));
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      HGHUB_DATA: dir,
      HGHUB_PORT: "0",
      HGHUB_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  let errors = "";
  child.stderr.on("data", (b) => (errors += b));
  try {
    const deadline = Date.now() + 10000;
    while (!/HGhubX English: http:\/\/127.0.0.1:\d+/.test(out)) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw Error(out + errors);
      await new Promise((r) => setTimeout(r, 30));
    }
    const base = /HGhubX English: (http:\/\/127.0.0.1:\d+)/.exec(out)[1];
    const password = /password \(save it\): (\S+)/.exec(out)[1];
    assert.equal((await fetch(base + "/api/state")).status, 401);
    assert.equal(
      (
        await fetch(base + "/auth", {
          method: "POST",
          body: JSON.stringify({ password: "bad" }),
        })
      ).status,
      401,
    );
    const auth = await fetch(base + "/auth", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    assert.equal(auth.status, 200);
    const cookie = auth.headers.get("set-cookie").split(";")[0];
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    assert.equal(
      (
        await fetch(base + "/api/state", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    const save = async (data) =>
      (
        await fetch(base + "/api/state", {
          method: "POST",
          headers,
          body: JSON.stringify(data),
        })
      ).json();
    await save({ history: [{ id: 1, ep: 1, t: 10, dur: 100, at: 100 }] });
    await save({ history: [{ id: 2, ep: 3, t: 20, dur: 200, at: 200 }] });
    const s = await save({
      history: [{ id: 1, ep: 1, t: 1, dur: 100, at: 1 }],
    });
    assert.equal(s.history.length, 2);
    assert.equal(s.history.find((h) => h.id === 1).t, 10);
    assert.equal(
      (
        await fetch(
          base + "/media?u=" + encodeURIComponent("https://127.0.0.1/private"),
          { headers },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          base +
            "/media?u=" +
            encodeURIComponent("https://example.com") +
            "&key=guess",
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/api/catalog", {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "arbitrary-command" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          base + "/api/downloads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/cancel",
          { method: "GET", headers },
        )
      ).status,
      405,
    );
    // Offline playback supports ordinary and suffix Range requests used by Safari.
    const libdir = path.join(dir, "downloads");
    const key = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    fs.mkdirSync(path.join(libdir, key));
    fs.writeFileSync(
      path.join(libdir, key, "video.mp4"),
      Buffer.from("0123456789"),
    );
    // Unknown on-disk files must not be exposed unless present in the completed library.
    assert.equal(
      (await fetch(base + "/offline/" + key, { headers })).status,
      400,
    );
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
