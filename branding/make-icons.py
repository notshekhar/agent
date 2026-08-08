"""
Generate loop's icon.

The wordmark is the marketing site's: `loop_` in SF Mono at weight 700 with
-0.055em tracking, which is exactly what the site's mono stack resolves to on
macOS. Glyphs are baked to paths so the shipped SVG has no font dependency — an
icon that renders differently on a machine without SF Mono is not an icon.

The colours are the web UI's own light-theme tokens, read out of
`apps/web/src/index.css` rather than eyeballed, so the icon and the window it
launches are the same palette:

    plate   --background   zinc-25   oklch(99.2% 0 0)        #fcfcfc
    edge    --border       zinc-200  oklch(0.92 0.004 286)   #e4e4e7
    ink     --foreground   zinc-800  oklch(0.274 0.006 286)  #27272a
    caret   --primary                oklch(0.488 0.217 264)  #1b4ed8

The caret is the site's, and it earns its place: a prompt waiting for input says
"terminal" faster than any symbol, and it is the one spot of colour.

Two files come out of this. `loop-icon.svg` is the icon proper. `loop-mark-small.svg`
is the 16px favicon: four letters cannot survive 16 pixels — the counters close
and the word turns to grey mush — so at that size it falls back to `>_`, which is
two chunky shapes that stay legible and still read as a prompt.

Run: python3 make-icons.py    (needs fonttools)
"""
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.misc.transform import Transform

FONT = "/System/Library/Fonts/SFNSMono.ttf"
WEIGHT = 700
TRACKING_EM = -0.055
SIZE = 1024
RADIUS = 229

# apps/web/src/index.css, :root (light theme).
PLATE = "#fcfcfc"
EDGE = "#e4e4e7"
INK = "#27272a"
CARET = "#1b4ed8"

# How much the glyph corners are rounded, as a pen width. SF Mono's terminals
# are square; stroking each glyph in its own colour with a round-joined pen
# softens them without redrawing the letterforms by hand.
ROUND = 44

def squircle(size, inset=0.0, n=5.0, steps=256):
    """
    The plate outline, as a superellipse.

    Not `rx` on a rect. A rounded rectangle joins a circular arc to a straight
    edge, and curvature jumps at that join — the corner reads as a kink, which
    is the "square-ish" look. A superellipse (|x|^n + |y|^n = 1) has continuous
    curvature all the way round, which is the smooth corner macOS uses for app
    icons and what every other icon in the dock is shaped like.

    n=5 is the usual approximation of Apple's shape: n=2 would be an ellipse,
    n→∞ a square.
    """
    import math

    r = size / 2 - inset
    cx = cy = size / 2
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = cx + r * math.copysign(abs(ct) ** (2 / n), ct)
        y = cy + r * math.copysign(abs(st) ** (2 / n), st)
        pts.append(f"{x:.2f},{y:.2f}")
    return "M" + "L".join(pts) + "Z"


_font = None


def font():
    global _font
    if _font is None:
        _font = instancer.instantiateVariableFont(
            TTFont(FONT, fontNumber=0), {"wght": WEIGHT}
        )
    return _font


def glyph_paths(word, box):
    """Place `word` inside `box` = (x, y, w, h); returns [(char, path_d)]."""
    f = font()
    upem = f["head"].unitsPerEm
    cmap, gs, hmtx = f.getBestCmap(), f.getGlyphSet(), f["hmtx"]

    tracking = TRACKING_EM * upem
    x = 0.0
    placed = []
    for ch in word:
        name = cmap[ord(ch)]
        placed.append((ch, name, x))
        x += hmtx[name][0] + tracking

    # Fit on the real ink box, not the advance box: sidebearings would push a
    # short word visibly off-centre.
    ink = None
    for _, name, gx in placed:
        bp = BoundsPen(gs)
        gs[name].draw(TransformPen(bp, Transform().translate(gx, 0)))
        if bp.bounds is None:
            continue
        b = bp.bounds
        ink = b if ink is None else (
            min(ink[0], b[0]), min(ink[1], b[1]), max(ink[2], b[2]), max(ink[3], b[3])
        )

    bx, by, bw, bh = box
    ink_w, ink_h = ink[2] - ink[0], ink[3] - ink[1]
    scale = bw / ink_w
    tx = bx + (bw - ink_w * scale) / 2 - ink[0] * scale
    ty = by + (bh + ink_h * scale) / 2 + ink[1] * scale

    out = []
    for ch, name, gx in placed:
        pen = SVGPathPen(gs)
        gs[name].draw(
            TransformPen(pen, Transform(scale, 0, 0, -scale, tx, ty).translate(gx, 0))
        )
        d = pen.getCommands()
        if d:
            out.append((ch, d))
    return out


def group(items, color, round_px=ROUND):
    body = "\n".join(f'      <path d="{d}"/>' for _, d in items)
    return (
        f'    <g fill="{color}" stroke="{color}" stroke-width="{round_px}"\n'
        f'       stroke-linejoin="round" stroke-linecap="round">\n{body}\n    </g>'
    )


def plate(body, note):
    """
    The rounded plate.

    A drawn shape, NOT a full-bleed rect inside a `clipPath`: ImageMagick's SVG
    renderer silently ignores clip paths, so the clipped version rasterised with
    hard square corners while looking correct in a browser. The icon shipped
    square for exactly that reason. A path is honoured by every renderer, and
    the corners come out genuinely transparent — which is what the icon this
    replaced had.

    The hairline edge is the UI's own border token. A near-white plate would
    otherwise dissolve into a light dock or a light page; the UI defines its own
    cards the same way, so the icon is doing what the interface does.
    """
    inset = 6
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" width="{SIZE}" height="{SIZE}" role="img" aria-label="loop">
  <title>loop</title>
  <!--
    {note}

    SF Mono 700, {TRACKING_EM:+} em tracking, outlines baked to paths.
    Colours are the web UI's own light theme, read from apps/web/src/index.css:
    plate is background, edge is border, ink is foreground, caret is primary.
    The plate is a superellipse, so the corners have continuous curvature like
    every other icon in the dock rather than a rounded rectangle's kink.
    Regenerate with branding/make-icons.py.
  -->
  <path d="{squircle(SIZE)}" fill="{PLATE}"/>
{body}
  <path d="{squircle(SIZE, inset)}" fill="none" stroke="{EDGE}" stroke-width="12"/>
</svg>
"""


def icon():
    g = glyph_paths("loop_", (96, 0, SIZE - 192, SIZE))
    letters = [i for i in g if i[0] != "_"]
    caret = [i for i in g if i[0] == "_"]
    return plate(
        group(letters, INK) + "\n" + group(caret, CARET),
        "loop, as the marketing site sets it, in the web UI's colours.",
    )


def small():
    chevron = glyph_paths(">", (196, 0, 300, SIZE))
    caret = glyph_paths("_", (556, 0, 300, SIZE))
    return plate(
        group(chevron, INK, 64) + "\n" + group(caret, CARET, 64),
        "The 16px mark. Four letters cannot survive 16 pixels; a prompt can.",
    )


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    for name, svg in (("loop-icon.svg", icon()), ("loop-mark-small.svg", small())):
        with open(os.path.join(here, name), "w") as fh:
            fh.write(svg)
        print(name)
