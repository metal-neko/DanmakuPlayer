import { chmod, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const releaseDirectory = resolve(projectRoot, "release");
const installerTarget = resolve(releaseDirectory, "安装弹幕播放器.sh");

await mkdir(releaseDirectory, { recursive: true });
await copyFile(resolve(projectRoot, "scripts/install-appimage.sh"), installerTarget);
await chmod(installerTarget, 0o755);
await copyFile(
  resolve(projectRoot, "build-resources/icon.png"),
  resolve(releaseDirectory, "danmaku-player-icon.png"),
);
