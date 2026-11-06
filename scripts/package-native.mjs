// Small Linux distribution that uses the system's GTK/WebKit/GStreamer libraries.
import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

if (process.platform !== "linux") throw new Error("linux:native must run on Linux");
const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const { productName } = JSON.parse(await readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const name = `Danmaku-Player-${version}-${arch}`;
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run("npm", ["exec", "--", "tauri", "build", "--no-bundle"]);
const staging = resolve(root, "release/native", name);
await rm(staging, { recursive: true, force: true });
await mkdir(resolve(staging, "bin"), { recursive: true });
await mkdir(resolve(staging, "lib", productName), { recursive: true });
await copyFile(resolve(root, "src-tauri/target/release/danmaku-player"), resolve(staging, "bin/danmaku-player"));
await cp(resolve(root, "src-tauri/media-binaries"), resolve(staging, "lib", productName, "media"), { recursive: true });
await writeFile(resolve(staging, "启动弹幕播放器.sh"), '#!/bin/sh\napp_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$app_dir/bin/danmaku-player" "$@"\n');
await chmod(resolve(staging, "启动弹幕播放器.sh"), 0o755);
await chmod(resolve(staging, "bin/danmaku-player"), 0o755);
await copyFile(resolve(root, "build-resources/icon.png"), resolve(staging, "app-icon.png"));
await writeFile(resolve(staging, "使用说明.txt"), '解压后运行 ./启动弹幕播放器.sh，可传入视频路径。\n本包使用系统 GTK3、WebKitGTK 4.1、GStreamer 的 H.264/AAC 插件，内置 FFmpeg/ffprobe。\nArch/CachyOS：sudo pacman -S --needed webkit2gtk-4.1 gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav\n网页界面和视频解码均在本机运行。\n');
const archive = resolve(root, "release", `${name}.tar.gz`);
run("tar", ["-czf", archive, "-C", resolve(root, "release/native"), name]);
console.log(`Native Linux package: ${archive}`);
