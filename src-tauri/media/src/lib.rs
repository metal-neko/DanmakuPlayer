use axum::{
    body::Body,
    extract::State,
    http::{header, Method, Request, StatusCode},
    response::Response,
    Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    net::TcpListener,
    process::Command,
};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

pub fn supported(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let extensions: Vec<String> =
        serde_json::from_str(include_str!("../../../shared/video-formats.json")).unwrap();
    extensions.contains(&extension)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub path: String,
    pub url: String,
    pub name: String,
    pub size: u64,
    pub last_modified: u64,
}

pub fn source(path: &Path) -> Result<Source, String> {
    if !path.is_absolute() || !supported(path) {
        return Err("请选择支持的视频文件".into());
    }
    let metadata = path
        .metadata()
        .map_err(|_| "无法读取视频，请检查文件是否可以访问")?;
    if !metadata.is_file() {
        return Err("请选择视频文件".into());
    }
    Ok(Source {
        path: path.to_string_lossy().into(),
        url: String::new(),
        name: path.file_name().unwrap().to_string_lossy().into(),
        size: metadata.len(),
        last_modified: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Description {
    pub duration: f64,
    pub width: u64,
    pub height: u64,
    pub video_index: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_index: Option<u64>,
    pub mode: String,
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str()?.parse().ok())
}
fn preferred<'a>(items: &[&'a Value]) -> Option<&'a Value> {
    items
        .iter()
        .find(|s| s["disposition"]["default"].as_u64() == Some(1))
        .copied()
        .or_else(|| items.first().copied())
}

pub fn describe(probe: &Value, path: &Path, force: bool) -> Result<Description, String> {
    let streams = probe["streams"].as_array().ok_or("无法读取视频轨道")?;
    let videos: Vec<_> = streams
        .iter()
        .filter(|s| {
            s["codec_type"] == "video"
                && s["disposition"]["attached_pic"].as_u64().unwrap_or(0) == 0
        })
        .collect();
    let audios: Vec<_> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    let video = preferred(&videos).ok_or("文件中没有可播放的视频轨道")?;
    let audio = preferred(&audios);
    let duration = number(&probe["format"]["duration"])
        .or_else(|| number(&video["duration"]))
        .unwrap_or(0.0);
    if !duration.is_finite() || duration <= 0.0 {
        return Err("无法读取视频时长，文件可能损坏或尚未下载完成".into());
    }
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let codec = video["codec_name"].as_str().unwrap_or("");
    let audio_codec = audio.and_then(|s| s["codec_name"].as_str());
    let mp4 = ["mp4", "m4v", "mov"].contains(&extension.as_str())
        && codec == "h264"
        && video["pix_fmt"] == "yuv420p"
        && audio_codec.is_none_or(|c| ["aac", "mp3"].contains(&c));
    let webm = extension == "webm"
        && ["vp8", "vp9", "av1"].contains(&codec)
        && audio_codec.is_none_or(|c| ["opus", "vorbis"].contains(&c));
    let rotation = video["side_data_list"]
        .as_array()
        .and_then(|items| items.iter().find_map(|v| number(&v["rotation"])))
        .or_else(|| number(&video["tags"]["rotate"]))
        .unwrap_or(0.0);
    let rotated = rotation.abs() % 180.0 == 90.0;
    Ok(Description {
        duration,
        width: video[if rotated { "height" } else { "width" }]
            .as_u64()
            .unwrap_or(0),
        height: video[if rotated { "width" } else { "height" }]
            .as_u64()
            .unwrap_or(0),
        video_index: video["index"].as_u64().unwrap_or(0),
        audio_index: audio.and_then(|s| s["index"].as_u64()),
        mode: if !force && videos.len() == 1 && audios.len() <= 1 && (mp4 || webm) {
            "direct"
        } else {
            "compatible"
        }
        .into(),
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct Prepared {
    #[serde(flatten)]
    pub source: Source,
    #[serde(flatten)]
    pub description: Description,
    pub id: String,
}

#[derive(Default)]
struct Session {
    revision: u64,
    media: Option<Prepared>,
    cancel: CancellationToken,
    stream: CancellationToken,
}

#[derive(Clone, Serialize)]
pub struct MediaError {
    pub id: String,
    pub message: String,
}

struct Inner {
    session: Mutex<Session>,
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    port: u16,
    on_error: Arc<dyn Fn(MediaError) + Send + Sync>,
    shutdown: CancellationToken,
}

#[derive(Clone)]
pub struct MediaServer(Arc<Inner>);

pub fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

impl MediaServer {
    pub async fn start(
        ffmpeg: PathBuf,
        ffprobe: PathBuf,
        on_error: impl Fn(MediaError) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let inner = Arc::new(Inner {
            session: Mutex::new(Session::default()),
            ffmpeg,
            ffprobe,
            port,
            on_error: Arc::new(on_error),
            shutdown: CancellationToken::new(),
        });
        let server = Self(inner);
        let shutdown = server.0.shutdown.clone();
        let router = Router::new().fallback(serve).with_state(server.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await;
        });
        Ok(server)
    }

    pub fn release(&self) {
        let mut session = self.0.session.lock().unwrap();
        session.revision += 1;
        session.cancel.cancel();
        session.stream.cancel();
        session.cancel = CancellationToken::new();
        session.stream = CancellationToken::new();
        session.media = None;
    }

    pub fn close(&self) {
        self.release();
        self.0.shutdown.cancel();
    }

    pub async fn prepare(&self, path: &Path, force: bool) -> Result<Option<Prepared>, String> {
        // Reserve the revision under one lock so concurrent opens cannot share it.
        let (revision, cancel) = {
            let mut session = self.0.session.lock().unwrap();
            session.revision += 1;
            session.cancel.cancel();
            session.stream.cancel();
            session.cancel = CancellationToken::new();
            session.stream = CancellationToken::new();
            session.media = None;
            (session.revision, session.cancel.clone())
        };
        let source = source(path)?;
        let output = tokio::select! {
            _ = cancel.cancelled() => return Ok(None),
            result = tokio::time::timeout(Duration::from_secs(30), command(&self.0.ffprobe).args(["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json"]).arg(path).output()) => {
                result.map_err(|_| "无法读取视频，请检查文件是否完整且可以访问")?.map_err(|_| "缺少视频解码器，请重新安装播放器")?
            }
        };
        if !output.status.success() {
            return Err("无法读取视频，请检查文件是否完整且可以访问".into());
        }
        let probe: Value =
            serde_json::from_slice(&output.stdout).map_err(|_| "无法读取视频轨道")?;
        let description = describe(&probe, path, force)?;
        let id = uuid::Uuid::new_v4().to_string();
        let media = Prepared {
            source: Source {
                url: format!("http://127.0.0.1:{}/{}", self.0.port, id),
                ..source
            },
            description,
            id,
        };
        let mut session = self.0.session.lock().unwrap();
        if session.revision != revision {
            return Ok(None);
        }
        session.media = Some(media.clone());
        Ok(Some(media))
    }
}

pub fn parse_range(value: &str, size: u64) -> Result<(u64, u64), &'static str> {
    let (left, right) = value
        .strip_prefix("bytes=")
        .and_then(|s| s.split_once('-'))
        .ok_or("invalid range")?;
    if size == 0
        || (left.is_empty() && right.is_empty())
        || !left.bytes().all(|c| c.is_ascii_digit())
        || !right.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("invalid range");
    }
    let (start, end) = if left.is_empty() {
        let suffix: u64 = right.parse().map_err(|_| "invalid range")?;
        if suffix == 0 {
            return Err("invalid range");
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = left.parse().map_err(|_| "invalid range")?;
        let end = if right.is_empty() {
            size - 1
        } else {
            right
                .parse::<u64>()
                .map_err(|_| "invalid range")?
                .min(size - 1)
        };
        (start, end)
    };
    if start >= size || start > end {
        return Err("invalid range");
    }
    Ok((start, end))
}

fn response(status: StatusCode, body: Body) -> Response {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap()
}

async fn serve(State(server): State<MediaServer>, request: Request<Body>) -> Response {
    let (media, cancel) = {
        let session = server.0.session.lock().unwrap();
        (session.media.clone(), session.cancel.clone())
    };
    let Some(media) = media else {
        return response(StatusCode::NOT_FOUND, Body::empty());
    };
    if request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        != Some(format!("127.0.0.1:{}", server.0.port).as_str())
        || request.uri().path() != format!("/{}", media.id)
    {
        return response(StatusCode::NOT_FOUND, Body::empty());
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return response(StatusCode::METHOD_NOT_ALLOWED, Body::empty());
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    if media.description.mode == "direct" {
        let parsed = range.map(|r| parse_range(r, media.source.size));
        if parsed.as_ref().is_some_and(Result::is_err) {
            let mut result = response(StatusCode::RANGE_NOT_SATISFIABLE, Body::empty());
            result.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{}", media.source.size).parse().unwrap(),
            );
            return result;
        }
        let (start, end) = parsed
            .map(Result::unwrap)
            .unwrap_or((0, media.source.size.saturating_sub(1)));
        let Ok(mut file) = tokio::fs::File::open(&media.source.path).await else {
            return response(StatusCode::NOT_FOUND, Body::empty());
        };
        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return response(StatusCode::INTERNAL_SERVER_ERROR, Body::empty());
        }
        let body = if request.method() == Method::HEAD {
            Body::empty()
        } else {
            // Cancelling a session retires direct streams as well as decoder processes.
            let stream =
                ReaderStream::new(file.take(end - start + 1)).take_until(cancel.cancelled_owned());
            Body::from_stream(stream)
        };
        let mut result = response(
            if range.is_some() {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            },
            body,
        );
        let headers = result.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            if media.source.path.to_ascii_lowercase().ends_with(".webm") {
                "video/webm"
            } else {
                "video/mp4"
            }
            .parse()
            .unwrap(),
        );
        headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
        headers.insert(
            header::CONTENT_LENGTH,
            (end - start + 1).to_string().parse().unwrap(),
        );
        if range.is_some() {
            headers.insert(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{}", media.source.size)
                    .parse()
                    .unwrap(),
            );
        }
        return result;
    }
    let start = request
        .uri()
        .query()
        .unwrap_or("")
        .split('&')
        .find_map(|p| p.strip_prefix("start="))
        .unwrap_or("0")
        .parse::<f64>();
    let Ok(start) = start else {
        return response(StatusCode::BAD_REQUEST, Body::empty());
    };
    if !start.is_finite() || start < 0.0 || start >= media.description.duration {
        return response(StatusCode::BAD_REQUEST, Body::empty());
    }
    if range.is_some_and(|r| r != "bytes=0-") {
        return response(StatusCode::RANGE_NOT_SATISFIABLE, Body::empty());
    }
    let mut result = response(StatusCode::OK, Body::empty());
    result
        .headers_mut()
        .insert(header::CONTENT_TYPE, "video/mp4".parse().unwrap());
    result
        .headers_mut()
        .insert(header::ACCEPT_RANGES, "none".parse().unwrap());
    if request.method() == Method::HEAD {
        return result;
    }
    let stream_cancel = {
        let mut session = server.0.session.lock().unwrap();
        if session.media.as_ref().map(|m| &m.id) != Some(&media.id) {
            return response(StatusCode::NOT_FOUND, Body::empty());
        }
        session.stream.cancel();
        session.stream = CancellationToken::new();
        session.stream.clone()
    };
    let mut cmd = command(&server.0.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-ss",
        &start.to_string(),
        "-i",
        &media.source.path,
        "-map",
        &format!("0:{}", media.description.video_index),
    ]);
    if let Some(index) = media.description.audio_index {
        cmd.args(["-map", &format!("0:{index}")]);
    }
    cmd.args([
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=ceil(iw/2)*2:ceil(ih/2)*2",
        "-threads",
        "4",
        "-force_key_frames",
        "expr:gte(t,n_forced*1)",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ac",
        "2",
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration",
        "1000000",
        "-f",
        "mp4",
        "pipe:1",
    ]);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    let Ok(mut child) = cmd.spawn() else {
        (server.0.on_error)(MediaError {
            id: media.id,
            message: "无法启动视频解码器，请重新安装播放器".into(),
        });
        return response(StatusCode::INTERNAL_SERVER_ERROR, Body::empty());
    };
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    tokio::spawn(async move {
        let mut stream = ReaderStream::new(stdout);
        let result = tokio::select! {
            _ = cancel.cancelled() => return,
            _ = stream_cancel.cancelled() => return,
            _ = sender.closed() => return,
            result = async {
                while let Some(chunk) = stream.next().await {
                    if sender.send(chunk).await.is_err() { return None; }
                }
                child.wait().await.ok()
            } => result,
        };
        if result.is_some_and(|status| !status.success()) {
            (server.0.on_error)(MediaError {
                id: media.id,
                message: "视频解码失败，文件可能损坏或使用了不支持的编码".into(),
            });
            let _ = sender
                .send(Err(std::io::Error::other("decoder failed")))
                .await;
        }
    });
    *result.body_mut() = Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async { receiver.recv().await.map(|chunk| (chunk, receiver)) },
    ));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=2-5", 10), Ok((2, 5)));
        assert_eq!(parse_range("bytes=2-", 10), Ok((2, 9)));
        assert_eq!(parse_range("bytes=-4", 10), Ok((6, 9)));
        assert_eq!(parse_range("bytes=2-99", 10), Ok((2, 9)));
        for value in [
            "bytes=10-",
            "bytes=4-3",
            "bytes=-0",
            "bytes=-",
            "bytes=0-1,4-5",
        ] {
            assert!(parse_range(value, 10).is_err());
        }
    }
}
