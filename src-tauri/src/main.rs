#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod window_size;
use danmakumedia::{source, MediaServer, Prepared, Source};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct Initial {
    pending: Option<Source>,
    ready: bool,
}
struct Player {
    media: MediaServer,
    initial: Mutex<Initial>,
    dimensions: Mutex<Option<(f64, f64)>>,
}

fn argument(args: impl IntoIterator<Item = String>, cwd: &Path) -> Option<Source> {
    args.into_iter()
        .filter(|arg| !arg.starts_with("--"))
        .find_map(|arg| {
            let path = if arg.starts_with("file://") {
                tauri::Url::parse(&arg).ok()?.to_file_path().ok()?
            } else {
                cwd.join(arg)
            };
            source(&path).ok()
        })
}

fn open_source(app: &tauri::AppHandle, source: Source) {
    let player = app.state::<Player>();
    let mut initial = player.initial.lock().unwrap();
    initial.pending = Some(source.clone());
    if initial.ready {
        let _ = app.emit_to("main", "player:open-video", source);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn get_initial_video(player: State<'_, Player>) -> Option<Source> {
    let mut initial = player.initial.lock().unwrap();
    initial.ready = true;
    // Keep the value for the second StrictMode effect until a user opens another file.
    initial.pending.clone()
}

#[tauri::command]
async fn prepare_video(
    path: String,
    force_compatibility: bool,
    player: State<'_, Player>,
) -> Result<Option<Prepared>, String> {
    player
        .media
        .prepare(Path::new(&path), force_compatibility)
        .await
}
#[tauri::command]
fn release_video(player: State<'_, Player>) {
    player.media.release();
}

#[tauri::command]
async fn select_video(app: tauri::AppHandle) -> Result<Option<Source>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let extensions: Vec<String> =
            serde_json::from_str(include_str!("../../shared/video-formats.json")).unwrap();
        app.dialog()
            .file()
            .add_filter(
                "视频",
                &extensions.iter().map(String::as_str).collect::<Vec<_>>(),
            )
            .blocking_pick_file()
            .map(|file| {
                file.into_path()
                    .map_err(|e| e.to_string())
                    .and_then(|path| source(&path))
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn inspect_video(path: String) -> Result<Source, String> {
    source(Path::new(&path))
}

#[derive(Serialize)]
struct DanmakuFile {
    name: String,
    text: String,
}
#[tauri::command]
async fn read_danmaku(path: String) -> Result<DanmakuFile, String> {
    let path = Path::new(&path);
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !path.is_absolute() || !["xml", "ass"].contains(&extension.as_str()) {
        return Err("请选择 XML 或 ASS 弹幕文件".into());
    }
    let metadata = tokio::fs::metadata(path).await.map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("请选择 XML 或 ASS 弹幕文件".into());
    }
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    Ok(DanmakuFile {
        name: path.file_name().unwrap().to_string_lossy().into(),
        text: String::from_utf8_lossy(&bytes).into(),
    })
}

fn fit_window(window: &tauri::WebviewWindow, width: f64, height: f64) -> Result<bool, String> {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return Ok(false);
    }
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let frame_width = outer.width.saturating_sub(inner.width);
    let frame_height = outer.height.saturating_sub(inner.height);
    let area = monitor.work_area();
    let Some((w, h)) = window_size::fit(
        width,
        height,
        area.size.width.saturating_sub(frame_width) as f64,
        area.size.height.saturating_sub(frame_height) as f64,
    ) else {
        return Ok(false);
    };
    window
        .set_min_size(Some(PhysicalSize::new(w.min(320), h.min(240))))
        .map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            area.position.x + (area.size.width.saturating_sub(w + frame_width) / 2) as i32,
            area.position.y + (area.size.height.saturating_sub(h + frame_height) / 2) as i32,
        ))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn resize_to_video(
    width: f64,
    height: f64,
    window: tauri::WebviewWindow,
    player: State<'_, Player>,
) -> Result<bool, String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Ok(false);
    }
    *player.dimensions.lock().unwrap() = Some((width, height));
    fit_window(&window, width, height)
}

// Test scripts run only in debug builds and report through the real Tauri IPC.
#[tauri::command]
fn finish_desktop_test(app: tauri::AppHandle, success: bool, message: String) {
    if cfg!(debug_assertions) && std::env::var_os("DANMAKU_TEST_SCRIPT").is_some() {
        println!("{message}");
        app.exit(if success { 0 } else { 1 });
    }
}

fn media_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("media");
    if resources
        .join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        })
        .is_file()
    {
        return Ok(resources);
    }
    // Debug builds use the same staged, target-specific binaries as the installers.
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("media-binaries");
    if cfg!(debug_assertions) && development.is_dir() {
        return Ok(development);
    }
    Err("缺少视频解码器，请重新安装播放器".into())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(source) = argument(args, Path::new(&cwd)) {
                open_source(app, source);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_initial_video,
            prepare_video,
            release_video,
            select_video,
            inspect_video,
            read_danmaku,
            resize_to_video,
            finish_desktop_test
        ])
        .setup(|app| {
            let directory = media_directory(app.handle())?;
            let suffix = if cfg!(windows) { ".exe" } else { "" };
            let handle = app.handle().clone();
            let media = tauri::async_runtime::block_on(MediaServer::start(
                directory.join(format!("ffmpeg{suffix}")),
                directory.join(format!("ffprobe{suffix}")),
                move |error| {
                    let _ = handle.emit_to("main", "player:media-error", error);
                },
            ))?;
            let pending = argument(std::env::args().skip(1), &std::env::current_dir()?);
            app.manage(Player {
                media,
                initial: Mutex::new(Initial {
                    pending,
                    ready: false,
                }),
                dimensions: Mutex::new(None),
            });
            let mut window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .on_navigation(|url| {
                        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                            || (["http", "https"].contains(&url.scheme())
                                && url.host_str() == Some("tauri.localhost"))
                    })
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            if cfg!(debug_assertions) && std::env::var_os("DANMAKU_TEST_SCRIPT").is_some() {
                window = window.incognito(true);
            }
            window.build()?;
            Ok(())
        })
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished && cfg!(debug_assertions)
            {
                if let Some(path) = std::env::var_os("DANMAKU_TEST_SCRIPT") {
                    if let Ok(script) = std::fs::read_to_string(path) {
                        let _ = window.eval(&script);
                    }
                }
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<Player>().media.release();
            }
            if let tauri::WindowEvent::Resized(size) = event {
                let dimensions = *window.state::<Player>().dimensions.lock().unwrap();
                if let Some((width, height)) = dimensions {
                    if !window.is_maximized().unwrap_or(false)
                        && !window.is_fullscreen().unwrap_or(false)
                    {
                        if let Ok(Some(monitor)) = window.current_monitor() {
                            let outer = window.outer_size().unwrap_or(*size);
                            let area = monitor.work_area();
                            let frame_width = outer.width.saturating_sub(size.width);
                            let frame_height = outer.height.saturating_sub(size.height);
                            if let Some((target_width, target_height)) = window_size::fit(
                                size.width as f64,
                                size.width as f64 * height / width,
                                area.size.width.saturating_sub(frame_width) as f64,
                                area.size.height.saturating_sub(frame_height) as f64,
                            ) {
                                if size.width.abs_diff(target_width) > 2
                                    || size.height.abs_diff(target_height) > 2
                                {
                                    let _ = window
                                        .set_size(PhysicalSize::new(target_width, target_height));
                                }
                            }
                        }
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动弹幕播放器");
    app.run(|app, event| match event {
        tauri::RunEvent::Exit => app.state::<Player>().media.close(),
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if let Ok(source) = source(&path) {
                        open_source(app, source);
                        break;
                    }
                }
            }
        }
        _ => {}
    });
}
