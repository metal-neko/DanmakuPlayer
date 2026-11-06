import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

import { createMediaServer, getMediaBinaries } from "./helpers/media-server.mjs";
const binaries = getMediaBinaries();
const run = promisify(execFile);
let directory;
let server;
const errors = [];

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "danmaku-media-"));
  server = await createMediaServer({ ...binaries, onError: (error) => errors.push(error) });
});
after(async () => {
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(name, videoCodec, audioCodec, extra = []) {
  const filePath = path.join(directory, name);
  await run(binaries.ffmpeg, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", videoCodec,
    "-threads", "1", "-c:a", audioCodec, ...extra, "-shortest", "-y", filePath,
  ]);
  return filePath;
}

test("routes unsupported audio, 10-bit video and multiple tracks through compatibility decoding", async () => {
  const video = { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 160, height: 90 };
  const audio = { index: 1, codec_type: "audio", codec_name: "aac" };
  const probe = { format: { duration: "10" }, streams: [video, audio] };
  assert.equal((await server.describe(probe, "movie.mp4")).mode, "direct");
  assert.equal((await server.describe(probe, "movie.mp4", true)).mode, "compatible");
  assert.equal((await server.describe({ ...probe, streams: [video, { ...audio, codec_name: "ac3" }] }, "movie.mp4")).mode, "compatible");
  assert.equal((await server.describe({ ...probe, streams: [{ ...video, pix_fmt: "yuv420p10le" }, audio] }, "movie.mp4")).mode, "compatible");
  const multiple = await server.describe({ ...probe, streams: [video, audio, { ...audio, index: 2, disposition: { default: 1 } }] }, "movie.mp4");
  assert.equal(multiple.mode, "compatible");
  assert.equal(multiple.audioIndex, 2);
});

test("MP4 direct playback serves exact file bytes and seek ranges through a private URL", async () => {
  const filePath = await fixture("中文 空格 # sample.mp4", "libx264", "aac");
  const media = await server.prepare(filePath);
  assert.equal(media.mode, "direct");
  const original = await readFile(filePath);
  const response = await fetch(media.url, { headers: { Range: "bytes=12-127" } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original.subarray(12, 128));
  assert.equal((await fetch(media.url.replace(media.id, "unauthorized"))).status, 404);
  assert.equal((await fetch(media.url, { headers: { Range: "bytes=999999999-" } })).status, 416);
  await server.release();
  assert.equal((await fetch(media.url)).status, 404);
});

for (const [name, video, audio, extra] of [
  ["sample.avi", "mpeg4", "mp3", []],
  ["sample.mkv", "libx265", "ac3", ["-x265-params", "log-level=error:pools=1"]],
  ["sample.wmv", "wmv2", "wmav2", []],
  ["sample.flv", "flv", "mp3", ["-ar", "44100"]],
  ["sample.mpg", "mpeg2video", "mp2", ["-r", "25"]],
  ["sample.ts", "mpeg2video", "ac3", []],
  ["sample.mov", "mpeg4", "pcm_s16le", []],
  ["sample.ogv", "libtheora", "libvorbis", []],
]) {
  test(`${name}: streams playable H.264/AAC with a seek into the original timeline`, async () => {
    const filePath = await fixture(name, video, audio, extra);
    const media = await server.prepare(filePath);
    assert.equal(media.mode, "compatible");
    assert.ok(media.duration >= 3.9);
    const response = await fetch(`${media.url}?start=2`);
    assert.equal(response.status, 200);
    const output = path.join(directory, `${name}-result.mp4`);
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    const { stdout } = await run(binaries.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]);
    const decoded = JSON.parse(stdout);
    assert.equal(decoded.streams[0].codec_name, "h264");
    assert.equal(decoded.streams[1].codec_name, "aac");
    assert.ok(Number(decoded.format.duration) >= 1.8 && Number(decoded.format.duration) < 2.7, decoded.format.duration);
    await run(binaries.ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
  });
}

test("WebM keeps direct playback and silent video decodes without an audio map", async () => {
  const webm = await fixture("sample.webm", "libvpx-vp9", "libopus");
  assert.equal((await server.prepare(webm)).mode, "direct");
  const silent = path.join(directory, "silent.avi");
  await run(binaries.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x90:d=2", "-c:v", "mpeg4", silent]);
  const media = await server.prepare(silent);
  const response = await fetch(media.url);
  assert.ok((await response.arrayBuffer()).byteLength > 1000);
});

test("new opens cancel pending probes and retire old streams; corrupt files produce actionable errors", async () => {
  const first = server.prepare(path.join(directory, "sample.mkv"));
  const second = server.prepare(path.join(directory, "sample.avi"));
  assert.equal(await first, null);
  const current = await second;
  const response = await fetch(current.url);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  const corrupt = path.join(directory, "broken.mkv");
  await writeFile(corrupt, "invalid video");
  await assert.rejects(server.prepare(corrupt), /无法读取视频/);
  assert.equal((await fetch(current.url)).status, 404);
  await assert.rejects(server.prepare("https://example.com/video.mp4"), /请选择支持的视频文件/);
  assert.deepEqual(errors, []);
});
