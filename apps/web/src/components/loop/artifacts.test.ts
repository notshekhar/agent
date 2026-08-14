import { describe, expect, it } from "vite-plus/test";

import { loopCall } from "../../loop/transport";
import {
  artifactKindExecutes,
  artifactKindLabel,
  artifactResultSummary,
  artifactsForSession,
  parseArtifactResult,
  filterArtifacts,
  formatArtifactAge,
  formatArtifactSize,
  paginate,
} from "./artifacts";

const globals = globalThis as { window?: Window & typeof globalThis };

/** Same transport stub as `settings.test.ts` — the hook needs React to drive. */
function withLoop(handler: (method: string, params: unknown) => Promise<unknown>): {
  calls: Array<{ method: string; params: unknown }>;
  restore: () => void;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: (method, params) => {
      calls.push({ method, params });
      return handler(method, params);
    },
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
  };
  return {
    calls,
    restore: () => {
      if (previous === undefined) delete window.loop;
      else window.loop = previous;
      if (!hadWindow) delete globals.window;
    },
  };
}

describe("artifacts over the transport", () => {
  it("gets an openable url and path from loop, not built here", async () => {
    // loop composes both server-side (`artifactRow`), because it is the side
    // that knows where its config dir is. A client guessing the path would
    // break the moment the config dir moved.
    const loop = withLoop(() =>
      Promise.resolve([
        {
          id: "a1b2c3d4e5f6",
          title: "Q3 Report",
          kind: "html",
          createdAt: 1,
          updatedAt: 2,
          size: 11,
          written: true,
          path: "/home/u/.loop/artifacts/a1b2c3d4e5f6/index.html",
          url: "file:///home/u/.loop/artifacts/a1b2c3d4e5f6/index.html",
        },
      ]),
    );
    try {
      const rows = await loopCall<readonly { url: string; path: string }[]>("artifact.list");
      expect(rows[0]?.url.startsWith("file://")).toBe(true);
      expect(rows[0]?.path.endsWith("index.html")).toBe(true);
      expect(loop.calls).toEqual([{ method: "artifact.list", params: {} }]);
    } finally {
      loop.restore();
    }
  });

  it("deletes by id", async () => {
    const loop = withLoop(() => Promise.resolve({ deleted: true }));
    try {
      await loopCall("artifact.delete", { id: "a1b2c3d4e5f6" });
      expect(loop.calls).toEqual([{ method: "artifact.delete", params: { id: "a1b2c3d4e5f6" } }]);
    } finally {
      loop.restore();
    }
  });

  it("surfaces loop's refusal rather than swallowing it", async () => {
    const loop = withLoop(() => Promise.reject(new Error("no such artifact: nope")));
    try {
      await expect(loopCall("artifact.get", { id: "nope" })).rejects.toThrow("no such artifact");
    } finally {
      loop.restore();
    }
  });
});

const artifact = (id: string, title: string, description?: string) =>
  ({ id, title, description }) as unknown as Parameters<typeof filterArtifacts>[0][number];

describe("search", () => {
  const rows = [
    artifact("1", "Q3 Report", "revenue and churn"),
    artifact("2", "Migration plan"),
    artifact("3", "Q4 Report", "forecast"),
  ];

  it("returns everything for an empty or whitespace query", () => {
    expect(filterArtifacts(rows, "")).toHaveLength(3);
    expect(filterArtifacts(rows, "   ")).toHaveLength(3);
  });

  it("matches title and description, case-insensitively", () => {
    expect(filterArtifacts(rows, "report").map((r) => r.id)).toEqual(["1", "3"]);
    expect(filterArtifacts(rows, "CHURN").map((r) => r.id)).toEqual(["1"]);
  });

  it("narrows with each term rather than widening", () => {
    // Every term must match somewhere, so a second word is a filter, not an
    // OR that pulls unrelated rows back in.
    expect(filterArtifacts(rows, "q3 report").map((r) => r.id)).toEqual(["1"]);
    expect(filterArtifacts(rows, "report nothing")).toHaveLength(0);
  });

  it("tolerates a row with no description", () => {
    expect(filterArtifacts(rows, "migration").map((r) => r.id)).toEqual(["2"]);
  });
});

describe("pagination", () => {
  const items = Array.from({ length: 25 }, (_, index) => index + 1);

  it("slices a page and reports the range it is showing", () => {
    const first = paginate(items, 1, 10);
    expect(first.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([first.from, first.to, first.total, first.pageCount]).toEqual([1, 10, 25, 3]);

    const last = paginate(items, 3, 10);
    expect(last.items).toEqual([21, 22, 23, 24, 25]);
    expect([last.from, last.to]).toEqual([21, 25]);
  });

  it("clamps a page past the end instead of rendering nothing", () => {
    // Deleting the last row of the last page, or narrowing a search, would
    // otherwise leave the caller pointing past the end — which reads as
    // "no artifacts" when the truth is "no artifacts on page 9".
    const clamped = paginate(items, 9, 10);
    expect(clamped.page).toBe(3);
    expect(clamped.items).toEqual([21, 22, 23, 24, 25]);
  });

  it("clamps a page below the start, and junk input", () => {
    expect(paginate(items, 0, 10).page).toBe(1);
    expect(paginate(items, -4, 10).page).toBe(1);
    expect(paginate(items, Number.NaN, 10).page).toBe(1);
  });

  it("reports an empty list as one page showing 0–0", () => {
    const empty = paginate([], 1, 10);
    expect([empty.page, empty.pageCount, empty.total, empty.from, empty.to]).toEqual([
      1, 1, 0, 0, 0,
    ]);
  });

  it("does not paginate what already fits", () => {
    expect(paginate([1, 2, 3], 1, 10).pageCount).toBe(1);
  });
});

describe("row formatting", () => {
  it("scales size to the unit a page is actually measured in", () => {
    expect(formatArtifactSize(512)).toBe("512 B");
    expect(formatArtifactSize(2048)).toBe("2.0 KB");
    expect(formatArtifactSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("reads age coarsely — an exact timestamp is noise on a list row", () => {
    const now = Date.parse("2026-08-14T12:00:00Z");
    expect(formatArtifactAge(now - 5_000, now)).toBe("just now");
    expect(formatArtifactAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatArtifactAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatArtifactAge(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("never reports a future mtime as a negative age", () => {
    // Clock skew, or a file touched by something else a moment ahead of us.
    const now = Date.parse("2026-08-14T12:00:00Z");
    expect(formatArtifactAge(now + 60_000, now)).toBe("just now");
  });
});

describe("which lane a kind renders in", () => {
  it("treats html and svg as executable, everything else as inert", () => {
    // This is the security boundary of the viewer: `true` means the content
    // may only ever appear inside the sandboxed <webview>. svg is the one that
    // catches people out — an SVG document can carry <script>.
    expect(artifactKindExecutes("html")).toBe(true);
    expect(artifactKindExecutes("svg")).toBe(true);
    for (const kind of ["markdown", "json", "csv", "text"] as const) {
      expect(artifactKindExecutes(kind)).toBe(false);
    }
  });

  it("names every kind for a list row", () => {
    for (const kind of ["html", "markdown", "svg", "json", "csv", "text"] as const) {
      expect(artifactKindLabel(kind)).toBeTruthy();
      expect(artifactKindLabel(kind)).not.toBe("File"); // the fallback
    }
  });
});

describe("the artifact card payload", () => {
  // This parser is a port of core's. The separator is the contract between
  // them, so these cases mirror packages/core/test/artifact-tool.test.ts.
  const result = (payload: unknown) =>
    `Created artifact "Q3 Report" (a1b2c3d4e5f6).\nWrite the content to: /x\n artifact:${JSON.stringify(payload)}`;

  it("reads the card out of a tool result", () => {
    const payload = {
      id: "a1b2c3d4e5f6",
      title: "Q3 Report",
      kind: "markdown",
      path: "/home/u/.loop/artifacts/a1b2c3d4e5f6/index.md",
      url: "file:///home/u/.loop/artifacts/a1b2c3d4e5f6/index.md",
    };
    expect(parseArtifactResult(result(payload))).toEqual(payload);
  });

  it("keeps only the human half as the row's text", () => {
    const summary = artifactResultSummary(result({ id: "a1b2c3d4e5f6", title: "Q3 Report" }));
    // The JSON is for this component, not for anyone to read.
    expect(summary).not.toContain("artifact:{");
    expect(summary).toContain("Created artifact");
  });

  it("returns null for every other tool's output", () => {
    // Every tool's result flows through the same row renderer.
    for (const junk of ["", "Successfully wrote 12 bytes", "{}", null, undefined, 42]) {
      expect(parseArtifactResult(junk)).toBeNull();
    }
  });

  it("survives a truncated payload rather than throwing in a render", () => {
    expect(parseArtifactResult('Created artifact "X".\n artifact:{"id":"a1b2')).toBeNull();
    expect(artifactResultSummary("plain output")).toBe("plain output");
  });
});

describe("the card survives a thread reload", () => {
  // Mirrors packages/core/test/artifact-tool.test.ts. The JSON payload is
  // live-only — loop keeps it out of the model's context and the AI SDK
  // persists the model-facing value — so a reopened thread has only this.
  const persisted = 'Created artifact "Q3 Report" (a1b2c3d4e5f6).\nWrite the content to: /x';

  it("rebuilds the card from the persisted summary", () => {
    const card = parseArtifactResult(persisted);
    expect(card).toEqual({ id: "a1b2c3d4e5f6", title: "Q3 Report" });
  });

  it("still opens, because a card only needs the id", () => {
    // path/url are absent after a reload; the chip navigates by id and the
    // artifacts page resolves the rest.
    const card = parseArtifactResult(persisted)!;
    expect(card.url).toBeUndefined();
    expect(card.id).toBe("a1b2c3d4e5f6");
  });

  it("does not mistake ordinary prose for an artifact result", () => {
    expect(parseArtifactResult("Successfully wrote 812 bytes to artifact.ts")).toBeNull();
    expect(parseArtifactResult('the artifact "X" was fine')).toBeNull();
  });
});

describe("scoping artifacts to a chat", () => {
  const withSession = (id: string, sessionId?: string) =>
    ({ id, sessionId }) as unknown as Parameters<typeof artifactsForSession>[0][number];

  const rows = [
    withSession("1", "01M00SRPS7WW5PW8YA5M3WABZM"),
    withSession("2", "01KZZ9SH7DQQ672A6VH7CN0FV5"),
    withSession("3", "01M00SRPS7WW5PW8YA5M3WABZM"),
    withSession("4"), // headless run, or made before the field existed
  ];

  it("keeps only the session's own artifacts", () => {
    expect(artifactsForSession(rows, "01M00SRPS7WW5PW8YA5M3WABZM").map((r) => r.id)).toEqual([
      "1",
      "3",
    ]);
  });

  it("never matches an artifact that belongs to no chat", () => {
    expect(artifactsForSession(rows, "nope")).toHaveLength(0);
  });

  it("shows nothing rather than everything when there is no session", () => {
    // A draft thread has no session yet. Falling back to the full list would
    // claim artifacts this chat did not make.
    expect(artifactsForSession(rows, null)).toHaveLength(0);
  });
});
