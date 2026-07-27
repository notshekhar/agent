#!/usr/bin/env bash
# Builds the binary assets under site/ that browsers and crawlers need as real
# files:
#
#   site/og.png              <- site/og-template.html   (headless Chrome)
#   site/favicon.ico         <- site/favicon.svg        (ImageMagick)
#   site/favicon-16.png
#   site/favicon-32.png
#   site/apple-touch-icon.png
#
# Re-run after editing the template or the SVG, then commit the output.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
site="$root/site"

# ---- Open Graph card ------------------------------------------------------

chrome=""
for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)" \
    "$(command -v chromium-browser || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        chrome="$candidate"
        break
    fi
done

if [ -z "$chrome" ]; then
    echo "build-site-assets: no Chrome or Chromium found" >&2
    exit 1
fi

"$chrome" \
    --headless \
    --disable-gpu \
    --hide-scrollbars \
    --force-device-scale-factor=1 \
    --window-size=1200,630 \
    --screenshot="$site/og.png" \
    "file://$site/og-template.html" >/dev/null 2>&1

echo "built site/og.png"

# ---- favicons -------------------------------------------------------------

if ! command -v magick >/dev/null 2>&1; then
    echo "build-site-assets: ImageMagick (magick) not found — skipped favicons" >&2
    exit 0
fi

master="$(mktemp -t loop-favicon)"
trap 'rm -f "$master" "$master.png"' EXIT

# Rasterise once at high resolution, then downsample: going straight from the
# SVG to 16px loses the caret.
magick -background none "$site/favicon.svg" -resize 512x512 "$master.png"

magick "$master.png" -resize 16x16 "$site/favicon-16.png"
magick "$master.png" -resize 32x32 "$site/favicon-32.png"

# Multi-resolution .ico, still what some browsers and bookmark bars ask for.
magick "$master.png" -define icon:auto-resize=48,32,16 "$site/favicon.ico"

# iOS applies its own rounded mask, so flatten onto the brand background —
# our own rounded corners would otherwise show as dark notches.
magick "$master.png" -resize 180x180 \
    -background "#16181a" -alpha remove -alpha off \
    "$site/apple-touch-icon.png"

echo "built site/favicon.ico, favicon-16.png, favicon-32.png, apple-touch-icon.png"
