// Injected only by debug builds with DANMAKU_TEST_SCRIPT set.
(async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const video = () => document.querySelector('video');
  const waitFor = async (condition, label, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}; ${JSON.stringify({ src: video()?.src, time: video()?.currentTime, ready: video()?.readyState, error: video()?.error?.message })}; ${document.body.innerText}`);
  };
  const setProgress = (value) => {
    const input = document.querySelector('[aria-label="播放进度"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const startAt = (value) => video()?.readyState >= 2 && new URL(video().src).searchParams.get('start') === String(value);
  const clickPlay = async () => {
    await waitFor(() => document.querySelector('[aria-label="播放"]'), 'play-button state');
    document.querySelector('[aria-label="播放"]').click();
  };
  try {
    await waitFor(() => window.desktopPlayer && video()?.readyState >= 2, 'initial associated-file open');
    // WKWebView may require the original play-button gesture before autoplay.
    if (video().paused) await clickPlay();
    await waitFor(() => video()?.currentTime > 0.4, 'real audio/video decode');
    assert(!video().error, 'system WebView must decode H.264/AAC');
    assert(video().videoWidth === 320 && video().videoHeight === 180, 'decoded dimensions');
    video().pause();
    setProgress(4);
    await waitFor(() => startAt(4), 'seek while paused');
    assert(video().paused, 'seeking while paused must remain paused');
    assert(Math.abs(Number(document.querySelector('.timeline-input').value) - 4) < 0.2, 'original timeline');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['<?xml version="1.0"?><i><d p="4,1,25,16777215">同步测试弹幕</d></i>'], 'test.xml', { type: 'text/xml' }));
    document.querySelector('.video-stage').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    await waitFor(() => document.querySelector('.flying-comment')?.textContent === '同步测试弹幕', 'danmaku sync');
    await clickPlay();
    await waitFor(() => Number(document.querySelector('.timeline-input').value) > 4.5, 'resume');
    video().pause();
    setProgress(4);
    await waitFor(() => startAt(4), 'second seek');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await waitFor(() => startAt(0), 'keyboard seek');
    document.querySelector('[aria-label="打开菜单"]').click();
    Array.from(document.querySelectorAll('.drawer-tabs button')).find(button => button.textContent === '播放').click();
    const rate = document.querySelector('.compact-settings select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(rate, '1.5');
    rate.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.compact-settings .switch').click();
    assert(video().playbackRate === 1.5, 'speed');
    setProgress(7.4);
    await waitFor(() => startAt(7.4), 'seek near end');
    await clickPlay();
    await waitFor(() => new URL(video().src).searchParams.get('start') === '0' && video().currentTime > 0.1, 'loop');
    assert(video().playbackRate === 1.5, 'seek/loop preserve playback rate');
    const initial = await window.desktopPlayer.getInitialVideo();
    const directory = initial.path.slice(0, Math.max(initial.path.lastIndexOf('/'), initial.path.lastIndexOf('\\')) + 1);
    const emit = (event, payload) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event, payload });
    await emit('tauri://drag-enter', { paths: [initial.path], position: { x: 20, y: 20 } });
    await waitFor(() => document.querySelector('.video-stage.is-dragging'), 'native drag hover');
    const oldSource = video().src;
    await emit('tauri://drag-drop', { paths: [initial.path, `${directory}native.xml`], position: { x: 20, y: 20 } });
    await waitFor(() => video().src !== oldSource && document.querySelector('.flying-comment')?.textContent === '原生拖放弹幕', 'native video/XML drop');
    await emit('tauri://drag-drop', { paths: [`${directory}native.ass`], position: { x: 20, y: 20 } });
    await waitFor(() => document.querySelector('.flying-comment')?.textContent === 'ASS原生拖放', 'native ASS drop');
    assert(!document.querySelector('.video-stage.is-dragging'), 'drop clears hover');
    await window.__TAURI_INTERNALS__.invoke('finish_desktop_test', { success: true, message: 'PASS: Tauri system WebView initial open, playback, pause, seek, danmaku sync, keyboard, speed, loop and native video/XML/ASS drop bridge' });
  } catch (error) {
    await window.__TAURI_INTERNALS__.invoke('finish_desktop_test', { success: false, message: `${error.message ?? error}\n${error.stack ?? ''}` });
  }
})();
