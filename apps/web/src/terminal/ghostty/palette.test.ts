/**
 * The ANSI palette, proven against the real Ghostty WASM.
 *
 * `ghostty_terminal_set` has options for the default foreground, background
 * and cursor and NOTHING for the palette, so the terminal ran on Ghostty's
 * built-in colors — which are tuned for a dark background. In the app's light
 * theme that painted `bright white` and `yellow` in near-white ON white.
 *
 * `core.setTheme` therefore sends the palette as OSC 4 through the VT stream.
 * That is a claim about someone else's parser, so it is worth proving rather
 * than reasoning about: these boot the vendored WASM, write real escape
 * sequences and read the resolved cell colors back out.
 */
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { GhosttyTerminalCore, type GhosttyColor, type GhosttyTheme } from "./core";

const BLACK: GhosttyColor = { r: 0, g: 0, b: 0 };
const WHITE: GhosttyColor = { r: 255, g: 255, b: 255 };

/** Distinctive enough that a passing assertion cannot be a default in disguise. */
const RED_SLOT: GhosttyColor = { r: 12, g: 34, b: 56 };
const BRIGHT_WHITE_SLOT: GhosttyColor = { r: 7, g: 8, b: 9 };

const theme = (palette?: readonly GhosttyColor[]): GhosttyTheme => ({
  foreground: BLACK,
  background: WHITE,
  cursor: BLACK,
  ...(palette === undefined ? {} : { palette }),
});

/** ANSI 0-15 where only the two slots under test are recognisable. */
const testPalette = Array.from({ length: 16 }, (_, index) =>
  index === 1 ? RED_SLOT : index === 15 ? BRIGHT_WHITE_SLOT : { r: index, g: index, b: index },
);

beforeAll(() => {
  // The runtime fetches the wasm by app-relative URL, which node cannot parse.
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    // Vite appends query flags (`?no-inline`) to asset urls, so match on the
    // path and read the vendored file by name.
    const path = (typeof input === "string" ? input : String(input)).split("?", 1)[0] ?? "";
    if (path.endsWith(".wasm")) {
      const { readFile } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      const here = fileURLToPath(new URL(".", import.meta.url));
      const bytes = await readFile(`${here}vendor/${path.split("/").pop()}`);
      return new Response(new Uint8Array(bytes), {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return realFetch(input, init);
  });
});

async function coreWith(palette?: readonly GhosttyColor[]) {
  return await GhosttyTerminalCore.create(20, 4, 8, 16, theme(palette), () => {});
}

/** The foreground Ghostty resolved for the first cell of the top row. */
function firstCellForeground(core: GhosttyTerminalCore): GhosttyColor {
  const row = core.snapshot().rowData[0];
  const cell = row?.cells[0];
  if (!cell) throw new Error("the terminal drew nothing");
  return cell.foreground;
}

describe("themed ANSI colors", () => {
  it("paints SGR 31 in the palette's red, not Ghostty's", async () => {
    const core = await coreWith(testPalette);
    try {
      core.write("\u001b[31mX");
      expect(firstCellForeground(core)).toEqual(RED_SLOT);
    } finally {
      core.dispose();
    }
  });

  it("themes the bright slots too — the ones that vanish on white", async () => {
    const core = await coreWith(testPalette);
    try {
      core.write("\u001b[97mX");
      expect(firstCellForeground(core)).toEqual(BRIGHT_WHITE_SLOT);
    } finally {
      core.dispose();
    }
  });

  it("leaves Ghostty's own palette alone when a theme carries none", async () => {
    // The palette is optional, and an absent one must not blank the colors.
    const core = await coreWith();
    try {
      core.write("\u001b[31mX");
      const foreground = firstCellForeground(core);
      expect(foreground).not.toEqual(RED_SLOT);
      expect(foreground).not.toEqual(BLACK);
    } finally {
      core.dispose();
    }
  });

  it("survives the reset a reattach does before replaying scrollback", async () => {
    // RIS restores Ghostty's built-in palette, so without reapplying the theme
    // a reopened terminal repainted its whole buffer in the wrong colors.
    const core = await coreWith(testPalette);
    try {
      core.resetAndWrite("\u001b[31mX");
      expect(firstCellForeground(core)).toEqual(RED_SLOT);
    } finally {
      core.dispose();
    }
  });
});
