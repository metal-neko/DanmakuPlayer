import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Install the native bridge before React mounts, including in StrictMode.
export async function installDesktopBridge() {
  if (!isTauri()) return;
  const openListeners = new Set<Parameters<NonNullable<Window["desktopPlayer"]>["onOpenVideo"]>[0]>();
  const errorListeners = new Set<Parameters<NonNullable<Window["desktopPlayer"]>["onMediaError"]>[0]>();
  const dropListeners = new Set<(event: { type: string; paths?: string[] }) => void>();
  await listen<Parameters<NonNullable<Window["desktopPlayer"]>["onOpenVideo"]>[0] extends (value: infer T) => void ? T : never>("player:open-video", ({ payload }) => {
    for (const listener of openListeners) listener(payload);
  });
  await listen<{ id: string; message: string }>("player:media-error", ({ payload }) => {
    for (const listener of errorListeners) listener(payload);
  });
  await listen<{ paths: string[]; position: { x: number; y: number } }>("tauri://drag-enter", ({ payload }) => {
    for (const listener of dropListeners) listener({ type: "enter", ...payload });
  });
  await listen<{ paths: string[]; position: { x: number; y: number } }>("tauri://drag-drop", ({ payload }) => {
    for (const listener of dropListeners) listener({ type: "drop", ...payload });
  });
  await listen("tauri://drag-leave", () => {
    for (const listener of dropListeners) listener({ type: "leave" });
  });
  // Rust command errors are strings; present them through the existing notice UI.
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try { return await invoke<T>(command, args); }
    catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
  };
  window.desktopPlayer = {
    getInitialVideo: () => call("get_initial_video"),
    selectVideo: () => call("select_video"),
    inspectVideo: (path) => call("inspect_video", { path }),
    readDanmaku: (path) => call("read_danmaku", { path }),
    prepareVideo: (path, forceCompatibility = false) => call("prepare_video", { path, forceCompatibility }),
    releaseVideo: () => call("release_video"),
    resizeToVideo: (width, height) => call("resize_to_video", { width, height }),
    onOpenVideo: (callback) => { openListeners.add(callback); return () => { openListeners.delete(callback); }; },
    onMediaError: (callback) => { errorListeners.add(callback); return () => { errorListeners.delete(callback); }; },
    onNativeDrop: (callback) => { dropListeners.add(callback); return () => { dropListeners.delete(callback); }; },
  };
}
