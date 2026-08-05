import { describe, expect, it } from "vite-plus/test";

import { decodeProjectRouteId, encodeProjectRouteId } from "./projectRoute";

describe("project ids in URLs", () => {
  it("round-trips a filesystem path", () => {
    const path = "/Users/shekhar/Documents/notshekhar/loop";
    expect(decodeProjectRouteId(encodeProjectRouteId(path))).toBe(path);
  });

  it("produces a single URL segment with no reserved characters", () => {
    // The whole point: a project id contains "/", so it cannot ride in a route
    // segment as-is, and %2F does not round-trip consistently through the
    // router and history.
    const encoded = encodeProjectRouteId("/a/b c/d+e=f?g#h");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeProjectRouteId(encoded)).toBe("/a/b c/d+e=f?g#h");
  });

  it("round-trips non-ASCII paths", () => {
    const path = "/Users/shekhar/Documents/परियोजना/loop";
    expect(decodeProjectRouteId(encodeProjectRouteId(path))).toBe(path);
  });

  it("returns null for a param that is not one of ours", () => {
    expect(decodeProjectRouteId("!!!not-base64!!!")).toBeNull();
    expect(decodeProjectRouteId("")).toBeNull();
  });
});
