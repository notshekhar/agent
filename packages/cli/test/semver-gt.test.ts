import { describe, expect, test } from "bun:test";
import { semverGt } from "../src/commands";

describe("semverGt — the update checker's comparison", () => {
    test("orders plain releases, with or without the v prefix", () => {
        expect(semverGt("v0.19.29", "v0.19.28")).toBe(true);
        expect(semverGt("v0.19.28", "v0.19.29")).toBe(false);
        expect(semverGt("v0.19.29", "v0.19.29")).toBe(false);
        expect(semverGt("0.20.0", "v0.19.99")).toBe(true);
        expect(semverGt("v1.0.0", "v0.99.99")).toBe(true);
    });

    test("a numeric part is compared as a number, not as text", () => {
        // "27" < "3" as strings; the whole point of the comparison.
        expect(semverGt("v0.19.27", "v0.19.3")).toBe(true);
    });

    test("a release outranks its own prerelease", () => {
        // The hand-rolled comparison read both as 0.0.0-equal and said false,
        // so a user on a prerelease was told they were up to date.
        expect(semverGt("v1.0.0", "v1.0.0-beta.1")).toBe(true);
        expect(semverGt("v1.0.0-beta.1", "v1.0.0")).toBe(false);
    });

    test("prerelease numbers compare numerically", () => {
        expect(semverGt("v1.0.0-beta.10", "v1.0.0-beta.2")).toBe(true);
        expect(semverGt("v1.0.0-beta.2", "v1.0.0-beta.10")).toBe(false);
    });

    test("prerelease identifiers compare alphabetically", () => {
        expect(semverGt("v1.0.0-rc.1", "v1.0.0-beta.9")).toBe(true);
    });

    test("build metadata never affects precedence", () => {
        expect(semverGt("v1.0.0+build.9", "v1.0.0+build.1")).toBe(false);
        expect(semverGt("v1.0.0+build.1", "v1.0.0+build.9")).toBe(false);
    });

    test("an unparseable tag is not a newer version, and never throws", () => {
        // `a` is a tag name from the GitHub API, and the startup check calls
        // this without awaiting — a throw would be an unhandled rejection.
        for (const junk of ["nightly", "release-2024", "", "v", "latest"]) {
            expect(() => semverGt(junk, "v0.19.29")).not.toThrow();
            expect(semverGt(junk, "v0.19.29")).toBe(false);
        }
        expect(semverGt("v0.19.29", "not-a-version")).toBe(false);
    });
});
