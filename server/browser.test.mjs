import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
test("English UI: responsive browsing, translation, favorites and selected episode downloads", async (t) => {
  if (
    !fs.existsSync(process.env.HGHUB_CHROMIUM || "/usr/bin/chromium") ||
    !fs.existsSync("dist-web/index.html")
  ) {
    t.skip("Build the web app and install Chromium to run browser checks");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hghub-browser-"));
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, HGHUB_DATA: dir, HGHUB_PORT: "0", HGHUB_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  let browser;
  try {
    const deadline = Date.now() + 10000;
    while (!/HGhubX English: http:\/\/127.0.0.1:\d+/.test(log)) {
      if (Date.now() > deadline) throw Error(log);
      await new Promise((r) => setTimeout(r, 30));
    }
    const base = /HGhubX English: (http:\/\/127.0.0.1:\d+)/.exec(log)[1];
    const password = /password \(save it\): (\S+)/.exec(log)[1];
    browser = await chromium.launch({
      executablePath: process.env.HGHUB_CHROMIUM || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1024, height: 768 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const video = {
      id: 1,
      title: "中文标题",
      description: "中文说明",
      episode_count: 3,
      tags: ["中文标签"],
      author: { id: 10, name: "Creator" },
    };
    let state = {
      favs: [],
      history: [],
      blockedTags: [],
      blockedCreators: [],
      searchHist: [],
      hideWatched: false,
    };
    let jobs = [];
    await page.route("**/api/**", async (route) => {
      const req = route.request(),
        u = new URL(req.url());
      let data = {};
      if (u.pathname === "/api/status")
        data = {
          translation: {
            provider: "ollama",
            configured: true,
            model: "fixture",
          },
          quotaGB: 20,
        };
      else if (u.pathname === "/api/state") {
        if (req.method() === "POST")
          state = { ...state, ...req.postDataJSON() };
        data = state;
      } else if (u.pathname === "/api/translate")
        data = {
          text:
            req.postDataJSON().text === "中文说明"
              ? "English description"
              : "English title",
        };
      else if (u.pathname === "/api/catalog") {
        const a = req.postDataJSON();
        data =
          a.action === "detail"
            ? video
            : a.action === "play"
              ? { video_url: "" }
              : { items: [video], pagination: { pages: 1 } };
      } else if (u.pathname === "/api/downloads") {
        if (req.method() === "POST")
          jobs.push({
            ...req.postDataJSON(),
            key: String(jobs.length),
            status: "queued",
            progress: 0,
            bytes: 0,
          });
        data = jobs;
      }
      await route.fulfill({ json: data });
    });
    // Initial status is authenticated at the real endpoint before routes are installed in production;
    // use the real auth path here, then exercise all data paths with named fixtures.
    await page.goto(base);
    await page.getByRole("heading", { name: "Discover" }).waitFor();
    await page.getByRole("heading", { name: "English title" }).waitFor();
    await page.getByRole("button", { name: "☆ Save", exact: true }).click();
    assert.deepEqual(state.favs, [1]);
    await page
      .getByRole("button", { name: /English title.*3 episodes/ })
      .click();
    await page.getByRole("heading", { name: "English title" }).waitFor();
    await page.getByText("English description", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Download episode", exact: true })
      .click();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].ep, 1);
    await page.getByText("Select episodes to download").click();
    await page.locator(".episodes input").nth(1).check();
    await page.getByRole("button", { name: "Queue 1 selected" }).click();
    assert.equal(jobs[1].ep, 2);
    await page.getByRole("button", { name: "Downloads", exact: true }).click();
    await page.getByText("Episode 2 · standard · queued").waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.getByRole("heading", { name: "Discover" }).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    // Verify the real sign-in UI separately, without fixtures.
    const login = await browser.newPage();
    await login.goto(base);
    await login.getByLabel("Server access password").fill(password);
    await login.getByRole("button", { name: "Sign in", exact: true }).click();
    await login.getByRole("heading", { name: "Discover" }).waitFor();
  } finally {
    await browser?.close();
    child.kill();
    await new Promise((r) => child.once("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
