import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the danmaku player shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>弹幕播放器<\/title>/i);
  assert.match(html, /把本地视频拖到这里/);
  assert.match(html, /选择视频/);
  assert.match(html, /弹幕/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/i);
});

test("keeps XML and ASS support with per-video persistence", async () => {
  const [page, styles, installer, main, preload] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install-appimage.sh", import.meta.url), "utf8"),
    readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8"),
    readFile(new URL("../src/desktop.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /application\/xml/);
  assert.match(page, /Dialogue:/);
  assert.match(page, /indexedDB\.open\("glass-danmaku-player"/);
  assert.match(page, /全局弹幕延迟/);
  assert.match(page, /从这条弹幕开始/);
  assert.match(page, /搜索文字或时间/);
  assert.match(page, /style\.left = "100%"/);
  assert.match(page, /translate3d\(calc\(-\$\{travel\}px/);
  assert.doesNotMatch(page, /slice\(0, settings\.tracks \* 2\)/);
  assert.match(page, /resizeToVideo/);
  assert.equal(page.match(/onPointerUp=\{\(event\) => event\.currentTarget\.blur\(\)\}/g)?.length, 2);
  assert.match(styles, /\.control-surface[\s\S]*opacity:\s*0/);
  assert.match(styles, /\.control-surface:has\(:focus-visible\)/);
  assert.doesNotMatch(styles, /\.control-surface:focus-within/);
  assert.match(styles, /\.player-shell\.has-video[\s\S]*padding:\s*0/);
  assert.match(main, /is_maximized\(\).*is_fullscreen\(\)/);
  assert.match(preload, /resize_to_video/);
  assert.match(installer, /gtk-update-icon-cache/);
});
