import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LoopToolGroupRow } from "./LoopToolGroupRow";

const markup = (props: { label: string; failed: number; count: number }) =>
  renderToStaticMarkup(
    <LoopToolGroupRow {...props}>
      <div>src/app.ts</div>
    </LoopToolGroupRow>,
  );

describe("a folded run of tool calls", () => {
  it("reads as its label and the number of calls it stands for", () => {
    const html = markup({ label: "Read 3 files", failed: 0, count: 3 });
    expect(html).toContain("Read 3 files");
    expect(html).toContain("3 calls");
    expect(html).toContain('aria-expanded="false"');
  });

  it("hides the calls until the header is opened", () => {
    expect(markup({ label: "Read 3 files", failed: 0, count: 3 })).not.toContain("src/app.ts");
  });

  it("reports a failure it is hiding, so folding cannot lose bad news", () => {
    const html = markup({ label: "Read 2 files", failed: 1, count: 2 });
    expect(html).toContain("1 failed");
    expect(html).toContain("text-destructive");
  });

  it("says 1 call, not 1 calls", () => {
    expect(markup({ label: "Read 1 file", failed: 0, count: 1 })).toContain("1 call");
  });
});
