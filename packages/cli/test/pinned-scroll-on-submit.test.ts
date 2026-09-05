import { describe, expect, test } from "bun:test";
import { Container, ScrollView, Text, type Component } from "@notshekhar/loop-tui";

/**
 * Submitting in pinned-input mode used to leave the transcript wherever the
 * reader had scrolled it. The prompt is pinned, so typing was visible and the
 * message looked sent — but the transcript never moved, so the reply arrived
 * off-screen and the send looked like it had done nothing.
 *
 * revealPrompt is not the fix: it deliberately leaves a pinned reader's
 * position alone, because a keystroke is no reason to yank the page. Sending is
 * the explicit action that should move it, and pinned the transcript is its own
 * ScrollView — the terminal's scrollback is the wrong lever.
 */
function makeTranscript(lines: number, viewportHeight: number): { view: ScrollView; content: Container } {
    const content = new Container();
    for (let i = 0; i < lines; i++) content.addChild(new Text(`line ${i}`, 0, 0));
    const view = new ScrollView(content as Component, { follow: "end", primary: true });
    // Stand in for what the layout pass does each render.
    view.updateLayout(lines, viewportHeight, () => {});
    return { view, content };
}

const relayout = (view: ScrollView, content: Container, lines: number, viewportHeight: number): void => {
    view.updateLayout(lines, viewportHeight, () => {});
    void content;
};

describe("pinned transcript scroll on submit", () => {
    test("a reader scrolled back stops following the end", () => {
        const { view } = makeTranscript(100, 10);
        expect(view.isFollowingEnd).toBe(true);
        view.scrollTo(20);
        expect(view.isFollowingEnd).toBe(false);
        expect(view.scrollTop).toBe(20);
    });

    test("scrolling to the end re-arms follow, so the reply streams in", () => {
        const { view, content } = makeTranscript(100, 10);
        view.scrollTo(20);
        expect(view.isFollowingEnd).toBe(false);

        // What scrollTranscriptToEnd does in pinned mode.
        view.scrollTo(Number.MAX_SAFE_INTEGER);
        expect(view.isFollowingEnd).toBe(true);
        expect(view.scrollTop).toBe(90);

        // The reply grows the transcript; a followed view stays pinned to it.
        relayout(view, content, 140, 10);
        expect(view.scrollTop).toBe(130);
        expect(view.isFollowingEnd).toBe(true);
    });

    /**
     * The call happens right after addUser, before the new line has been laid
     * out — so the clamp is against a stale, smaller content height. It still
     * has to re-arm follow, or the fix only works when the timing is lucky.
     */
    test("re-arms follow even when the content height is still stale", () => {
        const { view, content } = makeTranscript(100, 10);
        view.scrollTo(20);

        view.scrollTo(Number.MAX_SAFE_INTEGER); // clamped to the OLD end
        expect(view.isFollowingEnd).toBe(true);

        relayout(view, content, 101, 10); // the user's message lands
        expect(view.scrollTop).toBe(91);
    });

    test("a transcript shorter than the viewport stays at the top", () => {
        const { view } = makeTranscript(4, 10);
        view.scrollTo(Number.MAX_SAFE_INTEGER);
        expect(view.scrollTop).toBe(0);
        expect(view.isFollowingEnd).toBe(true);
    });
});
