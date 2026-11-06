import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const kind = process.argv[2] ?? ({ linux: "appimage", win32: "nsis", darwin: "dmg" })[process.platform];
if (!kind || !["appimage", "nsis", "dmg"].includes(kind)) throw new Error("Choose appimage, nsis or dmg");
const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const targets = kind === "dmg" ? ["x86_64-apple-darwin", "aarch64-apple-darwin"] : [null];
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
await mkdir(resolve(root, "release"), { recursive: true });
for (const target of targets) {
  if (target) run("rustup", ["target", "add", target]);
  const args = ["exec", "--", "tauri", "build", "--bundles", kind];
  if (target) args.push("--target", target);
  const env = { ...process.env, ...(kind === "appimage" ? { APPIMAGE_EXTRACT_AND_RUN: "1" } : {}), ...(target ? { DANMAKU_TARGET: target } : {}) };
  if (kind === "appimage") {
    for (const [name, variable] of [["GSTREAMER_PLUGINS_DIR", "pluginsdir"], ["GSTREAMER_HELPERS_DIR", "pluginscannerdir"]]) {
      if (env[name]) continue;
      const result = spawnSync("pkg-config", [`--variable=${variable}`, "gstreamer-1.0"], { encoding: "utf8" });
      if (result.status !== 0 || !result.stdout.trim()) throw new Error(`Install GStreamer development files; cannot locate ${variable}`);
      env[name] = result.stdout.trim();
    }
  }
  run("npm", args, env);
  const bundle = resolve(root, "src-tauri/target", target ?? "", "release/bundle", kind);
  const extension = { appimage: ".AppImage", nsis: ".exe", dmg: ".dmg" }[kind];
  const files = (await readdir(bundle)).filter((name) => name.endsWith(extension));
  if (files.length !== 1) throw new Error(`Expected one ${kind} installer in ${bundle}, found ${files.length}`);
  const arch = target?.startsWith("aarch64") || (!target && process.arch === "arm64") ? "arm64" : "x64";
  const destination = resolve(root, "release", `Danmaku-Player-${version}-${arch}${extension}`);
  await copyFile(resolve(bundle, files[0]), destination);
  if (kind === "appimage") await chmod(destination, 0o755);
}
if (kind === "appimage") run("node", ["scripts/stage-appimage-installer.mjs"]);
