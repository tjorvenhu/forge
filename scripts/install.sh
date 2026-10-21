#!/bin/sh
# FORGE installer for macOS and Linux, the counterpart of FORGE-Setup.exe on Windows:
#
#   curl -fsSL https://forge.vanturis.de/install.sh | sh
#
# Always the same script: it looks up the newest release on GitHub that has a build for this system,
# downloads it, checks it against the SHA-256 digest GitHub keeps for every release file and installs it.
# macOS: FORGE.app in /Applications (or ~/Applications). Linux: the AppImage as ~/.local/bin/forge with a
# menu entry. FORGE updates itself afterwards. Nothing here needs root.
#
# FORGE_VERSION=0.1.120 picks a version, FORGE_INSTALL_DIR another target folder.

set -eu

REPO="vanturis/forge"
ICON_URL="https://raw.githubusercontent.com/$REPO/main/apps/desktop/src-tauri/icons/128x128@2x.png"

case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  de*) DE=1 ;;
  *) DE=0 ;;
esac

# say "English" "Deutsch"
say() { if [ "$DE" = 1 ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
fail() {
  if [ "$DE" = 1 ]; then printf 'FORGE: %s\n' "$2" >&2; else printf 'FORGE: %s\n' "$1" >&2; fi
  exit 1
}

for tool in curl tar uname; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing." "$tool fehlt."
done

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin)
    # A shell under Rosetta reports x86_64 on Apple silicon; the native build is the right one there.
    if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
    case "$arch" in
      arm64) platform=darwin-arm64 ;;
      x86_64) platform=darwin-x64 ;;
      *) fail "Unsupported Mac ($arch)." "Dieser Mac wird nicht unterstützt ($arch)." ;;
    esac
    suffix=".app.tar.gz"
    # The bundled Node.js 24 needs macOS 13.5.
    macos=$(sw_vers -productVersion 2>/dev/null || echo 0)
    major=${macos%%.*}
    minor=$(printf '%s' "$macos" | cut -d. -f2)
    if [ "$major" -lt 13 ] 2>/dev/null || { [ "$major" -eq 13 ] && [ "${minor:-0}" -lt 5 ]; } 2>/dev/null; then
      fail "FORGE needs macOS 13.5 or later (this Mac has $macos)." "FORGE braucht macOS 13.5 oder neuer (dieser Mac hat $macos)."
    fi
    ;;
  Linux)
    case "$arch" in
      x86_64 | amd64) platform=linux-x64 ;;
      *) fail "FORGE for Linux exists for x86_64 only, not for $arch." "FORGE für Linux gibt es nur für x86_64, nicht für $arch." ;;
    esac
    suffix=".AppImage"
    ;;
  *)
    fail "This installer is for macOS and Linux. On Windows use FORGE-Setup.exe from https://forge.vanturis.de/download" \
      "Dieser Installer ist für macOS und Linux. Unter Windows nimm FORGE-Setup.exe von https://forge.vanturis.de/download"
    ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is missing." "sha256sum oder shasum fehlt."
fi

say "Looking for the newest FORGE for $platform ..." "Suche die neueste FORGE-Version für $platform ..."
releases=$(curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases?per_page=40") ||
  fail "GitHub cannot be reached." "GitHub ist nicht erreichbar."

# The API answers with indented JSON, one field per line; in every asset "digest" comes before
# "browser_download_url", and every release names "prerelease" before its assets. Releases are listed
# newest first. Pre-releases are dev builds: skipped unless FORGE_VERSION asks for one.
want="_${platform}${suffix}"
if [ -n "${FORGE_VERSION:-}" ]; then want="/FORGE_${FORGE_VERSION}${want}"; fi
found=$(printf '%s\n' "$releases" | awk -v want="$want\"" -v anypre="${FORGE_VERSION:+1}" '
  /"prerelease":/ { pre = index($0, "true") > 0 }
  /"digest":/ { d = $0 }
  /"browser_download_url":/ {
    if (index($0, want) && (!pre || anypre)) {
      u = $0; sub(/.*"browser_download_url": *"/, "", u); sub(/".*/, "", u)
      if (d ~ /sha256:/) { sub(/.*sha256:/, "", d); sub(/".*/, "", d) } else d = ""
      print u " " d; exit
    }
    d = ""
  }')
[ -n "$found" ] || fail "There is no FORGE build for $platform yet. See https://forge.vanturis.de/download" \
  "Für $platform gibt es noch keine FORGE-Version. Siehe https://forge.vanturis.de/download"
url=${found%% *}
digest=${found#* }
[ "$digest" != "$url" ] && [ -n "$digest" ] || fail "GitHub lists no checksum for $url." "GitHub nennt keine Prüfsumme für $url."
file=${url##*/}
version=$(printf '%s' "$file" | sed 's/^FORGE_\([^_]*\)_.*/\1/')

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t forge)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading FORGE $version ..." "Lade FORGE $version herunter ..."
curl -fL --progress-bar -o "$tmp/$file" "$url" || fail "The download failed." "Der Download ist fehlgeschlagen."
[ "$(sha "$tmp/$file")" = "$digest" ] || fail "The download does not match its checksum. Nothing was installed." \
  "Der Download passt nicht zu seiner Prüfsumme. Es wurde nichts installiert."

if [ "$os" = Darwin ]; then
  pgrep -x forge-desktop >/dev/null 2>&1 && fail "FORGE is running. Quit it and run the installer again." \
    "FORGE läuft. Beende es und starte den Installer noch einmal."
  tar -xzf "$tmp/$file" -C "$tmp" || fail "The download cannot be unpacked." "Der Download lässt sich nicht entpacken."
  [ -d "$tmp/FORGE.app" ] || fail "FORGE.app is missing in the download." "Im Download fehlt FORGE.app."
  dir=${FORGE_INSTALL_DIR:-/Applications}
  if [ -z "${FORGE_INSTALL_DIR:-}" ] && [ ! -w /Applications ]; then dir="$HOME/Applications"; fi
  mkdir -p "$dir"
  rm -rf "$dir/FORGE.app.forge-old"
  [ -e "$dir/FORGE.app" ] && mv "$dir/FORGE.app" "$dir/FORGE.app.forge-old"
  if mv "$tmp/FORGE.app" "$dir/FORGE.app"; then
    rm -rf "$dir/FORGE.app.forge-old"
  else
    [ -e "$dir/FORGE.app.forge-old" ] && mv "$dir/FORGE.app.forge-old" "$dir/FORGE.app"
    fail "FORGE could not be copied to $dir." "FORGE ließ sich nicht nach $dir kopieren."
  fi
  # Downloaded with curl it carries no quarantine flag; a copy that went through a browser before may.
  xattr -dr com.apple.quarantine "$dir/FORGE.app" 2>/dev/null || true
  say "FORGE $version is installed in $dir." "FORGE $version ist in $dir installiert."
  command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1 ||
    say "FORGE needs git: run  xcode-select --install" "FORGE braucht git: führe  xcode-select --install  aus"
  open "$dir/FORGE.app" 2>/dev/null || true
  exit 0
fi

# Linux
dir=${FORGE_INSTALL_DIR:-$HOME/.local/bin}
app="$dir/forge"
mkdir -p "$dir"
chmod 755 "$tmp/$file"
mv -f "$tmp/$file" "$app" || fail "FORGE could not be copied to $dir." "FORGE ließ sich nicht nach $dir kopieren."

data=${XDG_DATA_HOME:-$HOME/.local/share}
icons="$data/icons/hicolor/256x256/apps"
mkdir -p "$icons" "$data/applications"
curl -fsSL -o "$icons/forge.png" "$ICON_URL" 2>/dev/null || true
# AppImages need FUSE 2; without it they can still unpack themselves at every start.
run="$app"
if ! { ldconfig -p 2>/dev/null || true; } | grep -q 'libfuse\.so\.2'; then
  run="env APPIMAGE_EXTRACT_AND_RUN=1 $app"
  say "Note: libfuse2 is missing, FORGE starts more slowly without it (Ubuntu: sudo apt install libfuse2t64, older: libfuse2)." \
    "Hinweis: libfuse2 fehlt, ohne startet FORGE langsamer (Ubuntu: sudo apt install libfuse2t64, ältere: libfuse2)."
fi
cat >"$data/applications/forge.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=FORGE
Comment=Desktop app for Claude Code
Exec=$run
Icon=forge
Terminal=false
Categories=Development;
StartupWMClass=forge-desktop
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data/applications" >/dev/null 2>&1 || true

say "FORGE $version is installed: $app, and in the application menu." "FORGE $version ist installiert: $app, und im Anwendungsmenü."
case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "To start it as 'forge' in a terminal, add $dir to PATH." "Um es im Terminal als 'forge' zu starten, nimm $dir in den PATH auf." ;;
esac
command -v git >/dev/null 2>&1 || say "FORGE needs git: install it with your package manager (e.g. sudo apt install git)." \
  "FORGE braucht git: installiere es mit deinem Paketmanager (z. B. sudo apt install git)."
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  if [ "$run" = "$app" ]; then nohup "$app" >/dev/null 2>&1 & else APPIMAGE_EXTRACT_AND_RUN=1 nohup "$app" >/dev/null 2>&1 & fi
fi
