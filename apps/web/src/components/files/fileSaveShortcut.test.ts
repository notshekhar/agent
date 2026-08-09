import { describe, expect, it } from "vite-plus/test";

import { isSaveShortcut } from "./fileSaveShortcut";

const MAC = "MacIntel";
const WINDOWS = "Win32";

/**
 * The suite runs without a DOM, so this is the same structural event shape
 * `keybindings.ts` matches against rather than a real `KeyboardEvent`.
 */
const press = (
  key: string,
  modifiers: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

describe("isSaveShortcut", () => {
  it("is Cmd+S on macOS and Ctrl+S elsewhere", () => {
    expect(isSaveShortcut(press("s", { metaKey: true }), MAC)).toBe(true);
    expect(isSaveShortcut(press("s", { ctrlKey: true }), WINDOWS)).toBe(true);
  });

  /**
   * The wrong modifier for the platform belongs to somebody else. Ctrl+S on a
   * Mac reaches a terminal as ^S (flow control), and swallowing it here would
   * be taking a keystroke this pane was never given.
   */
  it("rejects the other platform's modifier", () => {
    expect(isSaveShortcut(press("s", { ctrlKey: true }), MAC)).toBe(false);
    expect(isSaveShortcut(press("s", { metaKey: true }), WINDOWS)).toBe(false);
  });

  it("rejects a bare s, so typing the letter never saves", () => {
    expect(isSaveShortcut(press("s"), MAC)).toBe(false);
    expect(isSaveShortcut(press("s"), WINDOWS)).toBe(false);
  });

  /** `mod+shift+s` and `mod+alt+s` are other commands, not this one. */
  it("rejects extra modifiers", () => {
    expect(isSaveShortcut(press("s", { metaKey: true, shiftKey: true }), MAC)).toBe(false);
    expect(isSaveShortcut(press("s", { metaKey: true, altKey: true }), MAC)).toBe(false);
    expect(isSaveShortcut(press("s", { ctrlKey: true, shiftKey: true }), WINDOWS)).toBe(false);
  });

  /** Shift is rejected, but the browser still reports the shifted letter. */
  it("accepts a capital S from a caps-locked keyboard", () => {
    expect(isSaveShortcut(press("S", { metaKey: true }), MAC)).toBe(true);
  });

  it("ignores every other key", () => {
    expect(isSaveShortcut(press("a", { metaKey: true }), MAC)).toBe(false);
    expect(isSaveShortcut(press("Enter", { metaKey: true }), MAC)).toBe(false);
  });
});
