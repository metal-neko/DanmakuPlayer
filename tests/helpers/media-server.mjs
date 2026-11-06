import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);

export function getMediaBinaries() {
  return { ffmpeg: require("ffmpeg-static"), ffprobe: require("ffprobe-static").path };
}

export async function createMediaServer({ ffmpeg, ffprobe, onError = () => {} }) {
  const child = spawn(resolve("src-tauri/target/debug", `media-harness${process.platform === "win32" ? ".exe" : ""}`), [ffmpeg, ffprobe], { stdio: ["pipe", "pipe", "inherit"] });
  let sequence = 0;
  let failure;
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const result = JSON.parse(line);
    if (result.event) { onError(result.value); return; }
    const callbacks = pending.get(result.id);
    pending.delete(result.id);
    if (result.error) callbacks.reject(new Error(result.error));
    else callbacks.resolve(result.value);
  });
  const fail = (error) => { failure = error; for (const callback of pending.values()) callback.reject(error); pending.clear(); };
  child.on("error", fail);
  const exited = new Promise((resolve) => child.on("exit", (code) => { fail(new Error(`Rust media service exited (${code})`)); resolve(); }));
  const call = (method, args = {}) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, ...args })}\n`);
  });
  return {
    prepare: (path, force = false) => call("prepare", { path, force }),
    describe: (probe, path, force = false) => call("describe", { probe, path, force }),
    release: () => call("release"),
    close: async () => { await call("close"); await exited; },
  };
}
