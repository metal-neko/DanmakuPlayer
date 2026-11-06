#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
bin_dir="$HOME/.local/bin"
application_dir="$data_dir/applications"
icon_dir="$data_dir/icons/hicolor/512x512/apps"
installed_app="$bin_dir/danmaku-player.AppImage"
desktop_file="$application_dir/danmaku-player.desktop"
installed_icon="$icon_dir/danmaku-player.png"

refresh_desktop_caches() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$application_dir" || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$data_dir/icons/hicolor" || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$installed_app" "$desktop_file" "$installed_icon"
  refresh_desktop_caches
  echo "弹幕播放器已卸载。"
  exit 0
fi

if [[ $# -gt 0 ]]; then
  appimage_path="$1"
else
  shopt -s nullglob
  candidates=("$script_dir"/Danmaku-Player-*.AppImage)
  if [[ ${#candidates[@]} -ne 1 ]]; then
    echo "请指定需要安装的 AppImage 路径。" >&2
    exit 1
  fi
  appimage_path="${candidates[0]}"
fi
icon_path="$script_dir/danmaku-player-icon.png"

if [[ ! -f "$appimage_path" ]]; then
  echo "找不到 AppImage：$appimage_path" >&2
  echo "用法：$0 [/完整路径/Danmaku-Player.AppImage]" >&2
  exit 1
fi

if [[ ! -f "$icon_path" ]]; then
  echo "找不到安装图标：$icon_path" >&2
  exit 1
fi

install -Dm755 "$appimage_path" "$installed_app"
install -Dm644 "$icon_path" "$installed_icon"
mkdir -p "$application_dir"

cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=弹幕播放器
Comment=播放本地视频与 XML、ASS 弹幕
Exec="$installed_app" %U
TryExec=$installed_app
Icon=danmaku-player
Terminal=false
Categories=AudioVideo;Player;
MimeType=video/mp4;video/x-matroska;video/webm;video/quicktime;video/x-msvideo;video/x-flv;video/mp2t;video/mpeg;video/x-ms-wmv;video/x-ms-asf;video/ogg;video/3gpp;video/3gpp2;application/vnd.rn-realmedia;application/vnd.rn-realmedia-vbr;
StartupWMClass=danmaku-player
EOF

refresh_desktop_caches

echo "弹幕播放器已安装。现在可以在视频的右键“打开方式”中选择它。"
