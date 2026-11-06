// Runs the actual Rust application and system WebView, with an isolated test profile.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-desktop-'));
let exitCode = 1;
try {
  const video = path.join(directory, '兼容 测试.mkv');
  execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'mpeg4', '-c:a', 'ac3', video]);
  fs.writeFileSync(path.join(directory, 'native.xml'), '<?xml version="1.0"?><i><d p="0,1,25,16777215">原生拖放弹幕</d></i>');
  fs.writeFileSync(path.join(directory, 'native.ass'), '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,ASS原生拖放');
  const result = spawnSync(path.resolve('src-tauri/target/debug', `danmaku-player${process.platform === 'win32' ? '.exe' : ''}`), [video], {
    stdio: 'inherit', timeout: 90000,
    env: { ...process.env, XDG_DATA_HOME: path.join(directory, 'data'), XDG_CACHE_HOME: path.join(directory, 'cache'), DANMAKU_TEST_SCRIPT: path.resolve('tests/desktop-in-webview.js') },
  });
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} finally {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* A WebView process may briefly hold the profile. */ }
}
process.exit(exitCode);
