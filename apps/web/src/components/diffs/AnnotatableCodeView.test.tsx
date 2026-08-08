import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const captured: { options: Record<string, unknown> | undefined } = { options: undefined };

vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: { options?: Record<string, unknown> }) => {
    captured.options = props.options;
    return null;
  },
}));

const { AnnotatableCodeView } = await import("./AnnotatableCodeView");

describe("AnnotatableCodeView", () => {
  it("hands CodeView a gutter-utility handler, or the '+' does nothing", () => {
    // `InteractionManager` only routes a pointerdown on the gutter "+" into a
    // selection when `onGutterUtilityClick` is set; without it the press falls
    // through to ordinary line selection, which refuses any path through the
    // utility button. The button was drawn, took the click, and opened no
    // comment — while dragging the line numbers still worked, which is what
    // made the diff look broken next to the file view.
    renderToStaticMarkup(
      <AnnotatableCodeView
        files={[]}
        sectionId="unstaged"
        sectionTitle="Working tree"
        composerDraftTarget={{ environmentId: "env", threadId: "thread" } as never}
        options={{}}
        renderHeaderPrefix={() => null}
      />,
    );

    expect(typeof captured.options?.onGutterUtilityClick).toBe("function");
    expect(captured.options?.enableGutterUtility).toBe(true);
    expect(captured.options?.enableLineSelection).toBe(true);
  });
});
