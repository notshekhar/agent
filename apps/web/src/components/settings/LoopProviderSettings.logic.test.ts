import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderRows,
  connectionState,
  connectionSummary,
  filterProviderRows,
  primaryMethod,
} from "./LoopProviderSettings.logic";
import type { LoopProviderStatus } from "../../loop/providers/auth";

const status = (overrides: Partial<LoopProviderStatus> & { id: string }): LoopProviderStatus => ({
  kind: "builtin",
  authorized: false,
  mode: "missing",
  methods: ["apikey"],
  ...overrides,
});

describe("buildProviderRows", () => {
  it("puts connected providers first, then sorts the rest by label", () => {
    const rows = buildProviderRows({
      providers: [
        status({ id: "zenmux" }),
        status({ id: "anthropic" }),
        status({ id: "kimi", authorized: true, mode: "apikey" }),
      ],
      active: null,
    });

    expect(rows.map((row) => row.id)).toEqual(["kimi", "anthropic", "zenmux"]);
  });

  it("resolves catalog presentation, so a row is labelled by brand not by id", () => {
    const [row] = buildProviderRows({
      providers: [status({ id: "github-copilot" })],
      active: null,
    });

    expect(row!.presentation.label).toBe("GitHub Copilot");
    expect(row!.presentation.icon).toBeDefined();
  });

  it("still renders a provider the catalog has never heard of", () => {
    const [row] = buildProviderRows({
      providers: [status({ id: "some-new-provider" })],
      active: null,
    });

    expect(row!.presentation.label).toBe("Some New Provider");
    expect(row!.presentation.icon).toBeUndefined();
    expect(row!.methods.map((method) => method.method)).toEqual(["apikey"]);
  });

  it("marks the provider loop has selected as active", () => {
    const rows = buildProviderRows({
      providers: [status({ id: "anthropic" }), status({ id: "openai" })],
      active: "openai",
    });

    expect(rows.find((row) => row.id === "openai")!.isActive).toBe(true);
    expect(rows.find((row) => row.id === "anthropic")!.isActive).toBe(false);
  });

  it("offers only the methods loop reports, even when the catalog describes more", () => {
    // The catalog gives openai both OAuth and an API key; a loop that reports
    // only one must not have the other rendered.
    const [row] = buildProviderRows({
      providers: [status({ id: "openai", methods: ["apikey"] })],
      active: null,
    });

    expect(row!.methods.map((method) => method.method)).toEqual(["apikey"]);
  });

  it("synthesizes a row for a method loop reports that the catalog omits", () => {
    const [row] = buildProviderRows({
      providers: [status({ id: "mistral", methods: ["apikey", "oauth"] })],
      active: null,
    });

    expect(row!.methods.map((method) => method.method)).toEqual(["apikey", "oauth"]);
  });
});

describe("connectionState", () => {
  it("separates a stored credential from one supplied by the environment", () => {
    // Both are authorized, but only the stored one can be disconnected — a
    // Disconnect button on the env-var case would delete nothing and leave the
    // provider connected.
    expect(
      connectionState(status({ id: "anthropic", authorized: true, mode: "apikey" })),
    ).toEqual({ kind: "connected", via: "apikey" });

    expect(
      connectionState(
        status({
          id: "anthropic",
          authorized: true,
          mode: "missing",
          envVar: "ANTHROPIC_API_KEY",
        }),
      ),
    ).toEqual({ kind: "environment", envVar: "ANTHROPIC_API_KEY" });
  });

  it("reports an OAuth sign-in distinctly from a pasted key", () => {
    expect(connectionState(status({ id: "xai", authorized: true, mode: "oauth" }))).toEqual({
      kind: "connected",
      via: "oauth",
    });
  });

  it("treats a custom gateway as its own kind, carrying the endpoint", () => {
    expect(
      connectionState(
        status({
          id: "custom:bifrost",
          kind: "custom",
          authorized: true,
          mode: "apikey",
          baseURL: "http://bifrost.internal/anthropic",
        }),
      ),
    ).toEqual({ kind: "custom", baseURL: "http://bifrost.internal/anthropic" });
  });

  it("is disconnected when nothing authorizes it", () => {
    expect(connectionState(status({ id: "groq" }))).toEqual({ kind: "disconnected" });
  });
});

describe("connectionSummary", () => {
  const rowFor = (input: LoopProviderStatus, modelCount = 0) =>
    buildProviderRows({
      providers: [input],
      active: null,
      modelCounts: new Map([[input.id, modelCount]]),
    })[0]!;

  it("counts models behind a connected provider", () => {
    expect(
      connectionSummary(rowFor(status({ id: "anthropic", authorized: true, mode: "apikey" }), 7)),
    ).toBe("API key · 7 models");
  });

  it("does not pluralize a single model", () => {
    expect(
      connectionSummary(rowFor(status({ id: "anthropic", authorized: true, mode: "apikey" }), 1)),
    ).toBe("API key · 1 model");
  });

  it("names the environment variable a key came from", () => {
    expect(
      connectionSummary(
        rowFor(status({ id: "groq", authorized: true, mode: "missing", envVar: "GROQ_API_KEY" })),
      ),
    ).toBe("Key from $GROQ_API_KEY");
  });

  it("falls back to the catalog tagline when nothing is connected", () => {
    expect(connectionSummary(rowFor(status({ id: "anthropic" })))).toBe(
      "Claude models, direct from Anthropic.",
    );
  });
});

describe("primaryMethod", () => {
  it("leads with OAuth over an API key, so no secret has to be pasted", () => {
    const [row] = buildProviderRows({
      providers: [status({ id: "openai", methods: ["apikey", "oauth"] })],
      active: null,
    });

    expect(primaryMethod(row!)!.method).toBe("oauth");
  });

  it("is null when loop reports no way in", () => {
    const [row] = buildProviderRows({
      providers: [status({ id: "custom:gw", kind: "custom", methods: [] })],
      active: null,
    });

    expect(primaryMethod(row!)).toBeNull();
  });
});

describe("filterProviderRows", () => {
  const rows = buildProviderRows({
    providers: [status({ id: "anthropic" }), status({ id: "kimi" }), status({ id: "groq" })],
    active: null,
  });

  it("keeps everything for an empty query", () => {
    expect(filterProviderRows(rows, "   ")).toHaveLength(3);
  });

  it("matches the brand label, not just the id", () => {
    expect(filterProviderRows(rows, "moonshot").map((row) => row.id)).toEqual(["kimi"]);
  });

  it("matches the id", () => {
    expect(filterProviderRows(rows, "groq").map((row) => row.id)).toEqual(["groq"]);
  });
});
