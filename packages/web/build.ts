#!/usr/bin/env bun
/**
 * Produce the self-contained page served by `loop serve` as a standalone
 * artifact (dist/web-ui.html) — for inspecting the exact payload releases
 * embed, or hosting it elsewhere. Core's build bakes the same page in via
 * build-page.ts, and a source run bundles it on the fly.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPage } from "./build-page";

const dist = join(import.meta.dir, "dist");
mkdirSync(dist, { recursive: true });
const page = await buildPage();
writeFileSync(join(dist, "web-ui.html"), page);
console.log(`built web UI (${Buffer.byteLength(page)} bytes)`);
