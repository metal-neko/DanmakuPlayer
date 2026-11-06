"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
} from "react";
import videoExtensions from "../shared/video-formats.json";

const videoAccept = ["video/*", ...videoExtensions.map((extension) => `.${extension}`)].join(",");

type DanmakuMode = "scroll" | "reverse" | "top" | "bottom";

type DanmakuItem = {
  id: string;
  baseTime: number;
  duration: number;
  text: string;
  color: string;
  mode: DanmakuMode;
};

type PlayerSettings = {
  globalDelay: number;
  itemDelays: Record<string, number>;
  enabled: boolean;
  opacity: number;
  fontSize: number;
  speed: number;
  tracks: number;
  playbackRate: number;
  fit: "contain" | "cover";
  loop: boolean;
};

type StoredProfile = {
  key: string;
  danmakuName: string;
  danmakuFile: Blob;
  settings: PlayerSettings;
  savedAt: number;
};

type DesktopVideoSource = {
  path: string;
  url: string;
  name: string;
  size: number;
  lastModified: number;
};

type PreparedVideo = DesktopVideoSource & {
  id: string;
  duration: number;
  width: number;
  height: number;
  mode: "direct" | "compatible";
};

declare global {
  interface Window {
    desktopPlayer?: {
      getInitialVideo: () => Promise<DesktopVideoSource | null>;
      selectVideo: () => Promise<DesktopVideoSource | null>;
      inspectVideo: (path: string) => Promise<DesktopVideoSource>;
      readDanmaku: (path: string) => Promise<{ name: string; text: string }>;
      onNativeDrop: (callback: (event: { type: string; paths?: string[] }) => void) => () => void;
      prepareVideo: (path: string, forceCompatibility?: boolean) => Promise<PreparedVideo | null>;
      releaseVideo: () => Promise<void>;
      onMediaError: (callback: (error: { id: string; message: string }) => void) => () => void;
      onOpenVideo: (callback: (source: DesktopVideoSource) => void) => () => void;
      resizeToVideo: (width: number, height: number) => Promise<boolean>;
    };
  }
}

const defaultSettings: PlayerSettings = {
  globalDelay: 0,
  itemDelays: {},
  enabled: true,
  opacity: 0.92,
  fontSize: 24,
  speed: 8,
  tracks: 8,
  playbackRate: 1,
  fit: "contain",
  loop: false,
};

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "--:--";
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatOffset(seconds: number) {
  if (Math.abs(seconds) < 0.001) return "0s";
  return `${seconds > 0 ? "+" : "−"}${Math.abs(seconds).toFixed(seconds % 1 ? 1 : 0)}s`;
}

function assTime(value: string) {
  const parts = value.trim().split(":").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function splitAssLine(value: string, limit = 10) {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length && parts.length < limit - 1; index += 1) {
    if (value[index] === ",") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function decimalColorToHex(value: string) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `#${Math.max(0, Math.min(0xffffff, number)).toString(16).padStart(6, "0")}`
    : "#ffffff";
}

async function parseDanmakuFile(file: Blob, name: string): Promise<DanmakuItem[]> {
  const text = (await file.text()).replace(/^\uFEFF/, "");
  const extension = name.split(".").pop()?.toLowerCase();

  if (extension === "xml" || text.trimStart().startsWith("<?xml")) {
    const documentNode = new DOMParser().parseFromString(text, "application/xml");
    if (documentNode.querySelector("parsererror")) throw new Error("XML 文件格式不正确");
    return Array.from(documentNode.querySelectorAll("d"))
      .map((node, index) => {
        const parts = (node.getAttribute("p") ?? "").split(",");
        const type = Number(parts[1]);
        const mode: DanmakuMode = type === 4 ? "bottom" : type === 5 ? "top" : type === 6 ? "reverse" : "scroll";
        return {
          id: `xml-${index}`,
          baseTime: Math.max(0, Number(parts[0]) || 0),
          duration: 8,
          text: node.textContent?.trim() ?? "",
          color: decimalColorToHex(parts[3] ?? "16777215"),
          mode,
        };
      })
      .filter((item) => item.text)
      .sort((a, b) => a.baseTime - b.baseTime);
  }

  if (extension === "ass" || /\[Events\]/i.test(text)) {
    const parsed: DanmakuItem[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!/^Dialogue:/i.test(line)) continue;
      const fields = splitAssLine(line.replace(/^Dialogue:\s*/i, ""));
      if (fields.length < 10) continue;
      const start = assTime(fields[1]);
      const end = assTime(fields[2]);
      const style = fields[3].toLowerCase();
      const rawText = fields[9];
      const colorTag = rawText.match(/\\c&H([0-9a-f]{6})/i)?.[1];
      const color = colorTag
        ? `#${colorTag.match(/../g)?.reverse().join("") ?? "ffffff"}`
        : "#ffffff";
      const cleanText = rawText
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\[Nn]/g, " ")
        .trim();
      if (!cleanText) continue;
      parsed.push({
        id: `ass-${parsed.length}`,
        baseTime: start,
        duration: Math.max(2, end - start || 8),
        text: cleanText,
        color,
        mode: style.includes("fix") || /\\pos\(/i.test(rawText) ? "top" : "scroll",
      });
    }
    return parsed.sort((a, b) => a.baseTime - b.baseTime);
  }

  throw new Error("暂不支持这个文件，请选择 .xml 或 .ass 弹幕文件");
}

function openProfileDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("glass-danmaku-player", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("profiles")) {
        request.result.createObjectStore("profiles", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getProfile(key: string) {
  const database = await openProfileDatabase();
  return new Promise<StoredProfile | undefined>((resolve, reject) => {
    const transaction = database.transaction("profiles", "readonly");
    const request = transaction.objectStore("profiles").get(key);
    request.onsuccess = () => resolve(request.result as StoredProfile | undefined);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function putProfile(profile: StoredProfile) {
  const database = await openProfileDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("profiles", "readwrite");
    transaction.objectStore("profiles").put(profile);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

function normalizeSettings(settings?: Partial<PlayerSettings>): PlayerSettings {
  return {
    ...defaultSettings,
    ...settings,
    itemDelays: settings?.itemDelays ?? {},
  };
}

function parseSearchTime(value: string) {
  const clean = value.trim();
  if (!/^\d{1,3}(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(clean)) return null;
  const parts = clean.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const danmakuInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const restoreRequestRef = useRef(0);
  const desktopAutoplayRef = useRef(false);
  const timeOffsetRef = useRef(0);
  const noticeTimeoutRef = useRef<number | undefined>(undefined);
  const compatibilityPendingRef = useRef(false);
  const resizedVideoRef = useRef(false);

  const [videoUrl, setVideoUrl] = useState("");
  const [desktopSource, setDesktopSource] = useState<PreparedVideo | null>(null);
  const [videoName, setVideoName] = useState("");
  const [videoKey, setVideoKey] = useState("");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.82);
  const [muted, setMuted] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"player" | "danmaku">("player");
  const [dragging, setDragging] = useState(false);
  const [comments, setComments] = useState<DanmakuItem[]>([]);
  const [danmakuSource, setDanmakuSource] = useState<{ file: Blob; name: string } | null>(null);
  const [settings, setSettings] = useState<PlayerSettings>(defaultSettings);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; index: number } | null>(null);

  const effectiveTime = useCallback(
    (item: DanmakuItem) => Math.max(0, item.baseTime + settings.globalDelay + (settings.itemDelays[item.id] ?? 0)),
    [settings.globalDelay, settings.itemDelays],
  );

  const activeComments = useMemo(() => {
    if (!settings.enabled) return [];
    return comments
      .map((item, index) => ({ item, index, start: effectiveTime(item) }))
      .filter(({ item, start }) => currentTime >= start && currentTime <= start + Math.min(item.duration, settings.speed));
  }, [comments, currentTime, effectiveTime, settings.enabled, settings.speed]);

  const updateSettings = useCallback((patch: Partial<PlayerSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const showNotice = useCallback((message: string) => {
    window.clearTimeout(noticeTimeoutRef.current);
    setNotice(message);
    noticeTimeoutRef.current = window.setTimeout(() => setNotice(""), 5000);
  }, []);

  const loadDanmaku = useCallback(async (file: Blob, name: string, restored = false) => {
    const requestId = restoreRequestRef.current;
    try {
      const parsed = await parseDanmakuFile(file, name);
      if (restoreRequestRef.current !== requestId) return;
      setComments(parsed);
      setDanmakuSource({ file, name });
      setSelectedId("");
      showNotice(`${restored ? "已恢复" : "已载入"} ${parsed.length} 条弹幕`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "弹幕文件读取失败");
    }
  }, [showNotice]);

  const openVideo = useCallback(async (input: File | DesktopVideoSource) => {
    const requestId = restoreRequestRef.current + 1;
    restoreRequestRef.current = requestId;
    videoRef.current?.pause();
    setVideoUrl("");
    setDesktopSource(null);
    setVideoName(input.name);
    setVideoKey("");
    setDuration(0);
    setCurrentTime(0);
    setIsPlaying(false);
    setComments([]);
    setDanmakuSource(null);
    setSettings(defaultSettings);
    timeOffsetRef.current = 0;
    compatibilityPendingRef.current = false;
    desktopAutoplayRef.current = false;
    resizedVideoRef.current = false;
    let source: DesktopVideoSource | File = input;
    try {
      if (window.desktopPlayer && !(input instanceof File)) {
        showNotice("正在读取视频…");
        const filePath = input.path;
        const prepared = await window.desktopPlayer.prepareVideo(filePath);
        if (!prepared || restoreRequestRef.current !== requestId) return;
        source = prepared;
        setDesktopSource(prepared);
        setDuration(prepared.duration);
        setVideoUrl(prepared.url);
        desktopAutoplayRef.current = true;
        showNotice(prepared.mode === "compatible" ? "已启用兼容播放，所有解码均在本机完成" : "");
      } else if (input instanceof File) {
        setVideoUrl(URL.createObjectURL(input));
      }
    } catch (error) {
      if (restoreRequestRef.current === requestId) showNotice(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "视频打开失败");
      return;
    }
    const key = `${source.name}:${source.size}:${Math.trunc(source.lastModified)}`;
    setVideoKey(key);
    try {
      const legacyKey = `${input.name}:${input.size}:${input.lastModified}`;
      const profile = await getProfile(key) ?? (legacyKey !== key ? await getProfile(legacyKey) : undefined);
      if (!profile || restoreRequestRef.current !== requestId) return;
      setSettings(normalizeSettings(profile.settings));
      await loadDanmaku(profile.danmakuFile, profile.danmakuName, true);
    } catch {
      if (restoreRequestRef.current === requestId) showNotice("视频已打开，但上次的弹幕记录未能读取");
    }
  }, [loadDanmaku, showNotice]);

  const chooseVideo = async () => {
    if (!window.desktopPlayer) { videoInputRef.current?.click(); return; }
    try {
      const source = await window.desktopPlayer.selectVideo();
      if (source) await openVideo(source);
    } catch (error) { showNotice(error instanceof Error ? error.message : "视频打开失败"); }
  };

  useEffect(() => window.desktopPlayer?.onNativeDrop((event) => {
    setDragging(event.type === "enter" || event.type === "over");
    if (event.type !== "drop" || !event.paths) return;
    const paths = event.paths;
    void (async () => {
      try {
        const bridge = window.desktopPlayer!;
        const video = paths.find((path) => videoExtensions.includes(path.split(".").pop()?.toLowerCase() ?? ""));
        const danmaku = paths.find((path) => /\.(xml|ass)$/i.test(path));
        const requestId = restoreRequestRef.current + (video ? 1 : 0);
        if (video) await openVideo(await bridge.inspectVideo(video));
        if (restoreRequestRef.current !== requestId) return;
        if (danmaku) {
          const file = await bridge.readDanmaku(danmaku);
          if (restoreRequestRef.current === requestId) await loadDanmaku(new Blob([file.text]), file.name);
        }
      } catch (error) { showNotice(error instanceof Error ? error.message : "文件打开失败"); }
    })();
  }), [openVideo, loadDanmaku, showNotice]);

  useEffect(() => {
    const bridge = window.desktopPlayer;
    if (!bridge) return;
    let active = true;
    const requestId = restoreRequestRef.current;
    const unsubscribe = bridge.onOpenVideo((source) => void openVideo(source));
    void bridge.getInitialVideo().then((source) => {
      if (active && source && restoreRequestRef.current === requestId) void openVideo(source);
    });
    return () => { active = false; unsubscribe(); };
  }, [openVideo]);

  useEffect(() => () => {
    if (videoUrl.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => () => {
    window.clearTimeout(noticeTimeoutRef.current);
    void window.desktopPlayer?.releaseVideo();
  }, []);

  useEffect(() => window.desktopPlayer?.onMediaError((error) => {
    if (error.id === desktopSource?.id) {
      setIsPlaying(false);
      showNotice(error.message);
    }
  }), [desktopSource, showNotice]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = settings.playbackRate;
  }, [settings.playbackRate]);

  useEffect(() => {
    if (!videoKey || !danmakuSource) return;
    const timeout = window.setTimeout(() => {
      void putProfile({
        key: videoKey,
        danmakuName: danmakuSource.name,
        danmakuFile: danmakuSource.file,
        settings,
        savedAt: Date.now(),
      });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [videoKey, danmakuSource, settings]);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const update = () => {
      if (videoRef.current) setCurrentTime(timeOffsetRef.current + videoRef.current.currentTime);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateWidth = () => setStageWidth(stage.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    document.addEventListener("click", closeMenu);
    return () => document.removeEventListener("click", closeMenu);
  }, []);

  const seek = (value: number, resume?: boolean) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(value) || duration <= 0) return;
    const target = Math.max(0, Math.min(value, Math.max(0, duration - 0.05)));
    if (desktopSource?.mode === "compatible") {
      desktopAutoplayRef.current = resume ?? (!video.paused || desktopAutoplayRef.current);
      video.pause();
      setIsPlaying(false);
      timeOffsetRef.current = target;
      setVideoUrl(`${desktopSource.url}?start=${target}&request=${Date.now()}`);
    } else {
      video.currentTime = target;
    }
    setCurrentTime(target);
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!videoUrl || !video) {
      await chooseVideo();
      return;
    }
    if (video.paused) {
      if (video.ended && desktopSource?.mode === "compatible") {
        seek(0, true);
        return;
      }
      try { await video.play(); } catch (error) {
        if (error instanceof Error && error.name !== "AbortError") showNotice("播放失败，请尝试重新打开视频");
      }
    }
    else video.pause();
  };

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) await stageRef.current?.requestFullscreen();
    else await document.exitFullscreen();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.code === "Space") {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key.toLowerCase() === "m") {
        setMuted((value) => !value);
      } else if (event.key.toLowerCase() === "d") {
        updateSettings({ enabled: !settings.enabled });
      } else if (event.key.toLowerCase() === "f") {
        void toggleFullscreen();
      } else if (event.key === "ArrowLeft" && videoRef.current) {
        seek(currentTime - 5);
      } else if (event.key === "ArrowRight" && videoRef.current) {
        seek(currentTime + 5);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const onVideoChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void openVideo(file);
    event.target.value = "";
  };

  const onDanmakuChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void loadDanmaku(file, file.name);
    event.target.value = "";
  };

  const onDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    const video = files.find((file) => file.type.startsWith("video/") || videoExtensions.includes(file.name.split(".").pop()?.toLowerCase() ?? ""));
    const danmaku = files.find((file) => /\.(xml|ass)$/i.test(file.name));
    const requestId = restoreRequestRef.current + (video ? 1 : 0);
    if (video) await openVideo(video);
    if (restoreRequestRef.current !== requestId) return;
    if (danmaku) void loadDanmaku(danmaku, danmaku.name);
  };

  const handleVideoError = async () => {
    if (compatibilityPendingRef.current) return;
    const bridge = window.desktopPlayer;
    if (bridge && desktopSource?.mode === "direct") {
      compatibilityPendingRef.current = true;
      const requestId = restoreRequestRef.current;
      showNotice("正在切换到兼容播放…");
      try {
        const prepared = await bridge.prepareVideo(desktopSource.path, true);
        if (!prepared || restoreRequestRef.current !== requestId) return;
        timeOffsetRef.current = Math.max(0, Math.min(currentTime, prepared.duration - 0.05));
        setDesktopSource(prepared);
        desktopAutoplayRef.current = true;
        setVideoUrl(`${prepared.url}?start=${timeOffsetRef.current}`);
      } catch (error) {
        if (restoreRequestRef.current === requestId) showNotice(error instanceof Error ? error.message : "兼容播放失败");
      } finally {
        if (restoreRequestRef.current === requestId) compatibilityPendingRef.current = false;
      }
    } else {
      setIsPlaying(false);
      showNotice(bridge ? "视频解码失败，请检查文件是否完整" : "浏览器无法播放此编码，请使用桌面版兼容播放");
    }
  };

  const adjustOne = (id: string, delta: number) => {
    setSettings((current) => ({
      ...current,
      itemDelays: {
        ...current.itemDelays,
        [id]: Number(((current.itemDelays[id] ?? 0) + delta).toFixed(2)),
      },
    }));
  };

  const adjustFrom = (index: number, delta: number | "reset") => {
    setSettings((current) => {
      const next = { ...current.itemDelays };
      for (const item of comments.slice(index)) {
        next[item.id] = delta === "reset" ? 0 : Number(((next[item.id] ?? 0) + delta).toFixed(2));
      }
      return { ...current, itemDelays: next };
    });
  };

  const findComment = () => {
    const clean = query.trim();
    if (!clean) return;
    const searchTime = parseSearchTime(clean);
    const match = searchTime === null
      ? comments.find((item) => item.text.toLocaleLowerCase().includes(clean.toLocaleLowerCase()))
      : comments
          .map((item) => ({ item, time: effectiveTime(item) }))
          .sort((a, b) => a.time - b.time)
          .find(({ time }) => time >= searchTime)?.item;
    if (!match) {
      showNotice("没有找到符合条件的弹幕");
      return;
    }
    setSelectedId(match.id);
    rowRefs.current[match.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const volumeLabel = muted || volume === 0 ? "静音" : volume < 0.5 ? "低音量" : "音量";

  return (
    <main className={`player-shell${videoUrl ? " has-video" : ""}`}>
      <section
        ref={stageRef}
        className={`video-stage${dragging ? " is-dragging" : ""}`}
        aria-label="弹幕播放器"
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={onDrop}
      >
        <input ref={videoInputRef} className="visually-hidden" type="file" accept={videoAccept} onChange={onVideoChange} />
        <input ref={danmakuInputRef} className="visually-hidden" type="file" accept=".xml,.ass,text/xml" onChange={onDanmakuChange} />

        {videoUrl ? (
          <video
            key={videoUrl}
            ref={videoRef}
            className={`video-element fit-${settings.fit}`}
            src={videoUrl}
            loop={settings.loop && desktopSource?.mode !== "compatible"}
            muted={muted}
            playsInline
            onClick={() => void togglePlayback()}
            onLoadedMetadata={(event) => {
              setDuration(desktopSource?.duration ?? event.currentTarget.duration);
              event.currentTarget.volume = volume;
              event.currentTarget.playbackRate = settings.playbackRate;
              if (!resizedVideoRef.current && event.currentTarget.videoWidth > 0 && event.currentTarget.videoHeight > 0) {
                resizedVideoRef.current = true;
                void window.desktopPlayer?.resizeToVideo(
                  event.currentTarget.videoWidth,
                  event.currentTarget.videoHeight,
                );
              }
              if (desktopAutoplayRef.current) {
                desktopAutoplayRef.current = false;
                void event.currentTarget.play().catch((error: Error) => {
                  if (error.name !== "AbortError") showNotice("点击播放按钮开始播放");
                });
              }
            }}
            onPlay={(event) => { if (event.currentTarget === videoRef.current) setIsPlaying(true); }}
            onPause={(event) => {
              if (event.currentTarget !== videoRef.current) return;
              setIsPlaying(false);
              setCurrentTime(timeOffsetRef.current + event.currentTarget.currentTime);
            }}
            onEnded={(event) => {
              setIsPlaying(false);
              const endedAt = timeOffsetRef.current + event.currentTarget.currentTime;
              if (desktopSource?.mode === "compatible" && endedAt < duration - 1) {
                showNotice("视频解码提前结束，请检查文件是否完整");
              } else if (settings.loop && desktopSource?.mode === "compatible") {
                seek(0, true);
              }
            }}
            onError={() => void handleVideoError()}
            onTimeUpdate={(event) => {
              if (event.currentTarget === videoRef.current) setCurrentTime(timeOffsetRef.current + event.currentTarget.currentTime);
            }}
          ><track kind="captions" /></video>
        ) : (
          <div className="empty-state">
            <img src="./app-icon.png" alt="弹幕播放器" className="empty-logo" />
            <p>把本地视频拖到这里</p>
            <button type="button" className="primary-button" onClick={() => void chooseVideo()}>选择视频</button>
            <span>视频不会上传，所有处理都在本机完成</span>
          </div>
        )}

        <div className="danmaku-layer" aria-hidden="true">
          {activeComments.map(({ item, index, start }) => {
            const life = Math.min(item.duration, settings.speed);
            const rawPhase = Math.max(0, Math.min(1, (currentTime - start) / life));
            const phase = rawPhase < 0.0125 ? 0 : rawPhase;
            const travel = phase * stageWidth;
            const lane = index % settings.tracks;
            const style: CSSProperties = {
              color: item.color,
              opacity: settings.opacity,
              fontSize: settings.fontSize,
              top: `${6 + lane * (68 / settings.tracks)}%`,
            };
            if (item.mode === "scroll") {
              style.left = "100%";
              style.transform = `translate3d(calc(-${travel}px - ${phase * 100}%), 0, 0)`;
            } else if (item.mode === "reverse") {
              style.right = "100%";
              style.transform = `translate3d(calc(${travel}px + ${phase * 100}%), 0, 0)`;
            } else {
              style.left = "50%";
              style.top = item.mode === "bottom" ? `${78 - lane * 4}%` : `${8 + lane * 4}%`;
              style.transform = "translateX(-50%)";
            }
            return <span key={item.id} className={`flying-comment mode-${item.mode}`} style={style}>{item.text}</span>;
          })}
        </div>

        {dragging && <div className="drop-hint">松开即可打开视频或弹幕文件</div>}

        <div className="control-reveal-zone" aria-hidden="true" />
        <div className="control-surface">
          <div className="control-row">
            <button className="icon-button menu-button" type="button" aria-label="打开菜单" onClick={() => setDrawerOpen(true)}>☰</button>
            <button className="icon-button play-button" type="button" aria-label={isPlaying ? "暂停" : "播放"} onClick={() => void togglePlayback()}>{isPlaying ? "Ⅱ" : "▶"}</button>
            <div className="volume-control">
              <button className="icon-button volume-button" type="button" aria-label={volumeLabel} onClick={() => setVolumeOpen((value) => !value)}>{muted || volume === 0 ? "×))" : volume < 0.5 ? "◖)" : "◖))"}</button>
              {volumeOpen && (
                <div className="volume-popover">
                  <span>{Math.round((muted ? 0 : volume) * 100)}</span>
                  <input
                    aria-label="音量"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={muted ? 0 : volume}
                    onPointerUp={(event) => event.currentTarget.blur()}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setVolume(next);
                      setMuted(false);
                      if (videoRef.current) videoRef.current.volume = next;
                    }}
                  />
                  <button type="button" onClick={() => setMuted((value) => !value)}>{muted ? "取消静音" : "静音"}</button>
                </div>
              )}
            </div>
            <div className="video-name" title={videoName || "尚未选择视频"}>{videoName || "尚未选择视频"}</div>
            <button
              className={`danmaku-button${settings.enabled ? " is-on" : ""}`}
              type="button"
              onClick={() => updateSettings({ enabled: !settings.enabled })}
              onContextMenu={(event) => { event.preventDefault(); setDrawerTab("danmaku"); setDrawerOpen(true); }}
              title="单击开关弹幕，右键打开弹幕设置"
            >
              弹幕 <span>{settings.enabled ? "开" : "关"}</span>
            </button>
            <button className="text-button" type="button" onClick={() => { setDrawerTab("danmaku"); setDrawerOpen(true); }}>设置</button>
            <button className="icon-button expand-button" type="button" aria-label="全屏" onClick={() => void toggleFullscreen()}>⛶</button>
          </div>
          <div className="timeline-row">
            <time>{formatTime(currentTime)}</time>
            <div className="timeline-glass">
              <div className="timeline-played" style={{ width: `${progress}%` }} />
              <input
                className="timeline-input"
                aria-label="播放进度"
                type="range"
                min="0"
                max={duration || 0}
                step="0.01"
                value={Math.min(currentTime, duration || 0)}
                onPointerUp={(event) => event.currentTarget.blur()}
                onChange={(event) => seek(Number(event.target.value))}
              />
            </div>
            <time>{formatTime(duration)}</time>
          </div>
        </div>

        <aside className={`settings-drawer${drawerOpen ? " is-open" : ""}`} aria-hidden={!drawerOpen}>
          <div className="drawer-header">
            <div className="drawer-title"><img src="./app-icon.png" alt="" /> <strong>播放器设置</strong></div>
            <button className="icon-button" type="button" aria-label="关闭设置" onClick={() => setDrawerOpen(false)}>×</button>
          </div>
          <div className="drawer-tabs" role="tablist">
            <button type="button" className={drawerTab === "player" ? "is-active" : ""} onClick={() => setDrawerTab("player")}>播放</button>
            <button type="button" className={drawerTab === "danmaku" ? "is-active" : ""} onClick={() => setDrawerTab("danmaku")}>弹幕 {comments.length > 0 && <em>{comments.length}</em>}</button>
          </div>

          {drawerTab === "player" ? (
            <div className="drawer-content player-settings">
              <section className="settings-section">
                <div className="section-label">本地视频</div>
                <button className="file-card" type="button" onClick={() => void chooseVideo()}>
                  <span className="file-icon">▶</span>
                  <span><strong>{videoName || "选择视频文件"}</strong><small>{videoName ? "更换视频" : "文件仅在本机读取"}</small></span>
                  <b>选择</b>
                </button>
              </section>
              <section className="settings-section compact-settings">
                <label><span>播放速度</span><select value={settings.playbackRate} onChange={(event) => {
                  const rate = Number(event.target.value);
                  updateSettings({ playbackRate: rate });
                  if (videoRef.current) videoRef.current.playbackRate = rate;
                }}><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
                <div className="setting-row"><span>画面适应</span><div className="segmented"><button className={settings.fit === "contain" ? "is-active" : ""} type="button" onClick={() => updateSettings({ fit: "contain" })}>完整</button><button className={settings.fit === "cover" ? "is-active" : ""} type="button" onClick={() => updateSettings({ fit: "cover" })}>铺满</button></div></div>
                <div className="setting-row"><span>循环播放</span><button type="button" className={`switch${settings.loop ? " is-on" : ""}`} onClick={() => updateSettings({ loop: !settings.loop })}><i /></button></div>
              </section>
              <section className="shortcut-card"><strong>快捷键</strong><span><kbd>Space</kbd> 播放 / 暂停</span><span><kbd>←</kbd><kbd>→</kbd> 前后 5 秒</span><span><kbd>D</kbd> 弹幕开关</span><span><kbd>F</kbd> 全屏</span></section>
            </div>
          ) : (
            <div className="drawer-content danmaku-settings">
              <section className="settings-section">
                <div className="section-label">弹幕文件</div>
                <button className="file-card" type="button" onClick={() => danmakuInputRef.current?.click()}>
                  <span className="file-icon danmaku-file-icon">弹</span>
                  <span><strong>{danmakuSource?.name || "选择 XML / ASS 文件"}</strong><small>{comments.length ? `${comments.length} 条 · 设置已自动保存` : videoName ? "会绑定到当前视频" : "选择视频后会自动记忆"}</small></span>
                  <b>{danmakuSource ? "更换" : "选择"}</b>
                </button>
              </section>

              {comments.length > 0 ? (
                <>
                  <section className="delay-card">
                    <div><span>全局弹幕延迟</span><strong className={settings.globalDelay === 0 ? "" : "has-delay"}>{formatOffset(settings.globalDelay)}</strong></div>
                    <div className="stepper">
                      <button type="button" onClick={() => updateSettings({ globalDelay: Number((settings.globalDelay - 1).toFixed(2)) })}>−1s</button>
                      <button type="button" className="reset-step" onClick={() => updateSettings({ globalDelay: 0 })}>归零</button>
                      <button type="button" onClick={() => updateSettings({ globalDelay: Number((settings.globalDelay + 1).toFixed(2)) })}>+1s</button>
                    </div>
                    <small>正数让全部弹幕延后，负数让全部弹幕提前</small>
                  </section>

                  <section className="search-section">
                    <div className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") findComment(); }} placeholder="搜索文字或时间，如 01:25" /><button type="button" onClick={findComment}>跳转</button></div>
                    <div className="list-caption"><span>弹幕列表</span><small>右键一条可批量调整其后弹幕</small></div>
                  </section>

                  <div className="comment-list">
                    {comments.map((item, index) => {
                      const itemDelay = settings.itemDelays[item.id] ?? 0;
                      const totalDelay = settings.globalDelay + itemDelay;
                      return (
                        <div
                          key={item.id}
                          ref={(node) => { rowRefs.current[item.id] = node; }}
                          className={`comment-row${selectedId === item.id ? " is-selected" : ""}`}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.target === event.currentTarget && (event.key === "Enter" || event.code === "Space")) {
                              event.preventDefault(); event.stopPropagation();
                              setSelectedId(item.id); seek(effectiveTime(item));
                            }
                          }}
                          onClick={() => { setSelectedId(item.id); seek(effectiveTime(item)); }}
                          onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setSelectedId(item.id);
                            setContextMenu({ x: event.clientX, y: event.clientY, index });
                          }}
                        >
                          <time>{formatTime(effectiveTime(item))}</time>
                          <span className="comment-text">{item.text}</span>
                          <span className={`offset-badge${totalDelay !== 0 ? " has-delay" : ""}`} title={`全局 ${formatOffset(settings.globalDelay)}，单条 ${formatOffset(itemDelay)}`}>{formatOffset(totalDelay)}</span>
                          <span className="row-actions">
                            <button type="button" aria-label="当前弹幕提前一秒" onClick={(event) => { event.stopPropagation(); adjustOne(item.id, -1); }}>−</button>
                            <button type="button" aria-label="当前弹幕延后一秒" onClick={(event) => { event.stopPropagation(); adjustOne(item.id, 1); }}>＋</button>
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <section className="display-settings">
                    <div className="setting-row"><span>显示弹幕</span><button type="button" className={`switch${settings.enabled ? " is-on" : ""}`} onClick={() => updateSettings({ enabled: !settings.enabled })}><i /></button></div>
                    <label><span>透明度 <b>{Math.round(settings.opacity * 100)}%</b></span><input type="range" min="0.2" max="1" step="0.05" value={settings.opacity} onChange={(event) => updateSettings({ opacity: Number(event.target.value) })} /></label>
                    <label><span>字号 <b>{settings.fontSize}px</b></span><input type="range" min="16" max="42" step="1" value={settings.fontSize} onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })} /></label>
                    <label><span>滚动时间 <b>{settings.speed}s</b></span><input type="range" min="4" max="14" step="1" value={settings.speed} onChange={(event) => updateSettings({ speed: Number(event.target.value) })} /></label>
                    <label><span>显示轨道 <b>{settings.tracks}</b></span><input type="range" min="4" max="14" step="1" value={settings.tracks} onChange={(event) => updateSettings({ tracks: Number(event.target.value) })} /></label>
                  </section>
                </>
              ) : (
                <div className="empty-comments"><span>弹</span><strong>还没有载入弹幕</strong><p>支持 Bilibili XML 与 ASS 字幕格式</p></div>
              )}
            </div>
          )}
        </aside>

        {drawerOpen && <button type="button" className="drawer-scrim" aria-label="关闭设置" onClick={() => setDrawerOpen(false)} />}

        {contextMenu && (
          <div className="context-menu" role="presentation" style={{ left: Math.min(contextMenu.x, window.innerWidth - 228), top: Math.min(contextMenu.y, window.innerHeight - 160) }} onClick={(event) => event.stopPropagation()}>
            <strong>从这条弹幕开始</strong>
            <button type="button" onClick={() => { adjustFrom(contextMenu.index, -1); setContextMenu(null); }}>其后全部提前 1 秒 <kbd>−1s</kbd></button>
            <button type="button" onClick={() => { adjustFrom(contextMenu.index, 1); setContextMenu(null); }}>其后全部延后 1 秒 <kbd>+1s</kbd></button>
            <button type="button" onClick={() => { adjustFrom(contextMenu.index, "reset"); setContextMenu(null); }}>清除其后单独延迟</button>
          </div>
        )}

        {notice && <div className="toast" role="status">{notice}</div>}
      </section>
    </main>
  );
}
