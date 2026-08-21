import type { Component } from "@notshekhar/loop-tui";

/**
 * A selector on its way to being painted OVER the frame instead of into it.
 *
 * Swapping a selector in for the editor makes the frame taller, and a frame
 * that fills the screen answers that by scrolling: the rows at the top go into
 * the terminal's scrollback, where they are committed and cannot be taken
 * back. Closing the selector makes the frame shorter again and those rows
 * cannot come home, so the prompt is left sitting above a blank band the width
 * of the menu that just closed. Painting the selector over the frame leaves
 * the frame's length alone — nothing scrolls on the way in, so there is
 * nothing to give back on the way out.
 *
 * What is left is coverage. The editor is still down there, rendering, and an
 * overlay only hides the rows it actually occupies — so a selector shorter
 * than the editor block would leave the top of the prompt showing above the
 * menu. Growing upwards into blank rows covers it, and costs nothing when the
 * selector is the taller of the two, which is the usual way round.
 */
export class SelectorOverlay implements Component {
    constructor(
        private readonly inner: Component,
        private readonly minRows: () => number,
    ) {}

    render(width: number): string[] {
        const lines = this.inner.render(width);
        const min = this.minRows();
        if (lines.length >= min) return lines;
        return [...new Array<string>(min - lines.length).fill(""), ...lines];
    }

    handleInput(data: string): void {
        this.inner.handleInput?.(data);
    }

    invalidate(): void {
        this.inner.invalidate();
    }
}
