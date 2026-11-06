// Stage only the requested target's binaries; Tauri embeds these as resources/media/.
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createWriteStream } = require("node:fs");
const { createGunzip } = require("node:zlib");

async function download(url, destination, compressed = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Media binary download failed (${response.status}): ${url}`);
  const temporary = `${destination}.partial`;
  try {
    const streams = [Readable.fromWeb(response.body)];
    if (compressed) streams.push(createGunzip());
    await pipeline(...streams, createWriteStream(temporary));
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function bundleMedia() {
  const triple = process.env.DANMAKU_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE;
  const platform = triple ? (triple.includes("windows") ? "win32" : triple.includes("apple") ? "darwin" : triple.includes("linux") ? "linux" : null) : process.platform;
  const arch = triple ? (triple.startsWith("aarch64") ? "arm64" : triple.startsWith("x86_64") ? "x64" : null) : process.arch;
  if (!platform || !["x64", "arm64"].includes(arch)) throw new Error("Unsupported media target: build separate x64/arm64 packages.");
  const suffix = platform === "win32" ? ".exe" : "";
  const projectRoot = path.resolve(__dirname, "..");
  const destination = path.join(projectRoot, "src-tauri", "media-binaries");
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  const packageDirectory = path.dirname(require.resolve("ffmpeg-static/package.json"));
  const metadata = require("ffmpeg-static/package.json")["ffmpeg-static"];
  const release = metadata["binary-release-tag"];
  const cache = path.join(projectRoot, ".media-binaries", release, `${platform}-${arch}`);
  await fs.mkdir(cache, { recursive: true });
  const binary = path.join(cache, `ffmpeg${suffix}`);
  const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}`;
  for (const extension of ["", ".LICENSE", ".README"]) {
    const target = `${binary}${extension}`;
    try { await fs.access(target); } catch {
      const local = path.join(packageDirectory, `ffmpeg${suffix}${extension}`);
      if (platform === process.platform && arch === process.arch) {
        try { await fs.copyFile(local, target); continue; } catch { /* Download missing install artifacts. */ }
      }
      const asset = extension ? `${platform}-${arch}${extension}` : `ffmpeg-${platform}-${arch}.gz`;
      await download(`${base}/${asset}`, target, !extension);
    }
  }
  for (const extension of ["", ".LICENSE", ".README"]) {
    await fs.copyFile(`${binary}${extension}`, path.join(destination, `ffmpeg${suffix}${extension}`));
  }
  const probeDirectory = path.dirname(require.resolve("ffprobe-static/package.json"));
  await fs.copyFile(path.join(probeDirectory, "bin", platform, arch, `ffprobe${suffix}`), path.join(destination, `ffprobe${suffix}`));
  await fs.copyFile(path.join(probeDirectory, "LICENSE"), path.join(destination, "ffprobe-wrapper.LICENSE"));
  await fs.copyFile(path.join(probeDirectory, "README.md"), path.join(destination, "ffprobe.README.md"));
  await fs.chmod(path.join(destination, `ffmpeg${suffix}`), 0o755);
  await fs.chmod(path.join(destination, `ffprobe${suffix}`), 0o755);
}

bundleMedia().catch((error) => { console.error(error); process.exitCode = 1; });
