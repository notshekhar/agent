import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { resolveLoopBinary } from "./loopProcess";

const temps: string[] = [];

function appDir(options: { bundled?: boolean; asarUnpacked?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "loop-desktop-"));
  temps.push(root);
  // What build.ts lays down, at the path main.ts resolves against.
  const appPath = options.asarUnpacked ? join(root, "Resources", "app.asar") : root;
  const realBase = options.asarUnpacked ? join(root, "Resources", "app.asar.unpacked") : root;
  if (options.bundled) {
    mkdirSync(join(realBase, "dist", "bin"), { recursive: true });
    writeFileSync(join(realBase, "dist", "bin", "loop"), "#!/bin/sh\n");
  }
  return appPath;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which loop the desktop app spawns", () => {
  test("prefers the bundled binary over anything installed", () => {
    // The whole point of shipping one: the app and its agent are a single
    // artifact, so the renderer can never call an RPC the binary predates.
    const appPath = appDir({ bundled: true });
    expect(resolveLoopBinary(undefined, appPath)).toBe(join(appPath, "dist", "bin", "loop"));
  });

  test("finds it in app.asar.unpacked when packaged", () => {
    // An executable cannot be spawned from inside an asar archive, so
    // packaging unpacks it and the real file sits beside the archive.
    const appPath = appDir({ bundled: true, asarUnpacked: true });
    const resolved = resolveLoopBinary(undefined, appPath);
    expect(resolved).toContain("app.asar.unpacked");
    expect(resolved.endsWith(join("dist", "bin", "loop"))).toBe(true);
  });

  test("an explicit LOOP_BINARY still wins — that is how you point at a checkout", () => {
    const appPath = appDir({ bundled: true });
    const override = mkdtempSync(join(tmpdir(), "loop-override-"));
    temps.push(override);
    const shim = join(override, "loop");
    writeFileSync(shim, "#!/bin/sh\n");
    expect(resolveLoopBinary(shim, appPath)).toBe(shim);
  });

  test("an override that does not exist is ignored rather than spawned", () => {
    const appPath = appDir({ bundled: true });
    expect(resolveLoopBinary("/nope/does/not/exist", appPath)).toBe(
      join(appPath, "dist", "bin", "loop"),
    );
  });

  test("falls back to an installed loop when nothing is bundled", () => {
    // A renderer-only rebuild is the common development case, and build.ts
    // deliberately does not fail it — so this path has to keep working.
    const resolved = resolveLoopBinary(undefined, appDir());
    expect(resolved.includes(join("dist", "bin"))).toBe(false);
  });
});
