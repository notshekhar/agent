import assert from "node:assert";
import { describe, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AutocompleteProvider } from "../src/autocomplete";
import { Editor } from "../src/components/editor";
import { type TUI } from "../src/tui";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";
import { TuiMainScreen } from "../src/tui-main-screen";

/**
 * The completion list, appended to the editor's own output, makes the editor —
 * and so the whole frame — taller for as long as it is open. A frame that
 * fills the screen pays for that by scrolling, which commits the rows at the
 * top to the terminal's scrollback, where they cannot be taken back: typing
 * `/` and deleting it again is enough to leave a blank band behind.
 *
 * Hosted, the rows come out of the editor's render and are painted over the
 * frame instead, so the editor's height does not move at all.
 */
function popupEditor(): { editor: Editor; ready: () => Promise<void> } {
    const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
    const provider: AutocompleteProvider = {
        getSuggestions: async (lines, _cursorLine, cursorCol) => ({
            items: [
                { value: "/help", label: "help" },
                { value: "/model", label: "model" },
                { value: "/settings", label: "settings" },
            ],
            prefix: (lines[0] || "").slice(0, cursorCol),
        }),
        applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    };
    editor.setAutocompleteProvider(provider);
    return {
        editor,
        ready: async () => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            await new Promise((resolve) => setTimeout(resolve, 0));
        },
    };
}

describe("a hosted completion list costs the editor no height", () => {
    it("the editor renders the same number of rows with the list open as without", async () => {
        const { editor, ready } = popupEditor();
        editor.setPopupHosted(true);
        const idle = editor.render(80).length;

        editor.handleInput("/");
        await ready();
        assert.strictEqual(editor.isShowingAutocomplete(), true, "the list is up");
        assert.strictEqual(editor.render(80).length, idle, "and the editor did not grow a single row");

        // The rows still exist — they are just someone else's to draw.
        const popup = editor.renderAutocompletePopup(80);
        assert.ok(popup.length > 0, "the host gets the rows");
        assert.ok(
            popup.some((line) => line.includes("help")),
            `and they are the completions: ${JSON.stringify(popup)}`,
        );
    });

    it("un-hosted, it still draws its own list — the default is unchanged", async () => {
        const { editor, ready } = popupEditor();
        const idle = editor.render(80).length;

        editor.handleInput("/");
        await ready();
        assert.ok(editor.render(80).length > idle, "the editor grows by the list it is drawing");
        const rendered = editor.render(80);
        assert.ok(rendered.some((line) => line.includes("help")));
    });

    it("hands the host nothing while the list is down, so it can ask every frame", () => {
        const { editor } = popupEditor();
        editor.setPopupHosted(true);
        assert.strictEqual(editor.isShowingAutocomplete(), false);
        assert.deepStrictEqual(editor.renderAutocompletePopup(80), []);
    });

    it("opens with a rule across the top, because it opens onto the conversation", async () => {
        // Appended below the editor, the list needed no top edge: the editor's
        // bottom border was the line between them. Painted above it, the list
        // sits straight on the transcript.
        const { editor, ready } = popupEditor();
        editor.setPopupHosted(true);
        editor.handleInput("/");
        await ready();

        const popup = editor.renderAutocompletePopup(40);
        const rule = stripVTControlCharacters(popup[0] ?? "");
        assert.strictEqual(rule, "─".repeat(40), `a full-width rule on top: ${JSON.stringify(rule)}`);
        assert.ok(
            popup.slice(1).some((line) => line.includes("help")),
            "with the completions under it",
        );
    });

    it("draws the same completions the editor used to append, under its new rule", async () => {
        const hosted = popupEditor();
        hosted.editor.setPopupHosted(true);
        hosted.editor.handleInput("/");
        await hosted.ready();

        const inline = popupEditor();
        inline.editor.handleInput("/");
        await inline.ready();

        // What the editor appends to itself is the list with no rule — the
        // bottom border above it is already doing that job.
        const appended = inline.editor.renderAutocompletePopup(80);
        assert.ok(appended[0]?.includes("help"), "un-hosted, no rule is added");
        const idle = inline.editor.render(80).length - appended.length;
        assert.deepStrictEqual(
            hosted.editor.renderAutocompletePopup(80).slice(1),
            inline.editor.render(80).slice(idle),
            "the same completion rows either way",
        );
    });
});
