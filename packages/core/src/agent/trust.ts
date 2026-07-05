/**
 * Project trust — gate executable/instruction project resources (hooks, project
 * skills) behind an explicit per-folder decision, so opening an untrusted cloned
 * repo doesn't silently run its `.loop`/`.claude` hooks. Ported (simplified) from
 * Trust manager: nearest-ancestor lookup, persisted in the `projects` table
 * (trust.json was migrated in and stays on disk unread).
 *
 * Decision: true = trusted, false = explicitly untrusted, null = not yet asked.
 * Resources load only when the nearest decision is `true`.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { allTrustRows, writeTrustRow } from "../sessions/projects";

export type TrustDecision = boolean | null;

function canonical(cwd: string): string {
    const resolved = resolve(cwd);
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}

/** True when the folder (or an ancestor) ships project resources worth gating. */
export function hasProjectTrustInputs(cwd: string): boolean {
    let dir = canonical(cwd);
    for (;;) {
        if (existsSync(join(dir, ".loop")) || existsSync(join(dir, ".claude"))) return true;
        const parent = dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
}

// Session-only trust grants (not persisted; live for the running process).
const sessionTrust = new Set<string>();

/** Nearest-ancestor trust decision; null when no ancestor has been decided. */
export function getTrustDecision(cwd: string): TrustDecision {
    const canon = canonical(cwd);
    if (sessionTrust.has(canon)) return true;
    // One SELECT for the (tiny) decided set, then the same ancestor walk —
    // a live query is what lets two concurrent loops see each other's grants.
    const data = allTrustRows();
    let dir = canon;
    for (;;) {
        const v = data.get(dir);
        if (v === true || v === false) return v;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/** Resources load only on an explicit `true`. */
export function isTrusted(cwd: string): boolean {
    return getTrustDecision(cwd) === true;
}

/** Persist a trust decision to the projects table. */
export function setTrust(cwd: string, decision: boolean): void {
    writeTrustRow(canonical(cwd), decision);
}

/** Trust for the running process only — not written to disk. */
export function trustForSession(cwd: string): void {
    sessionTrust.add(canonical(cwd));
}

export interface TrustOption {
    label: string;
    trusted: boolean;
    /** persist to the trust store (false = session-only, not remembered) */
    remember: boolean;
    /** path the decision is saved against (cwd or a parent) */
    savePath: string;
}

/** Selector options: trust / trust parent / session-only / no. */
export function getTrustOptions(cwd: string): TrustOption[] {
    const path = canonical(cwd);
    const parent = dirname(path);
    const opts: TrustOption[] = [{ label: "Trust this folder", trusted: true, remember: true, savePath: path }];
    if (parent !== path) {
        opts.push({ label: `Trust parent folder (${parent})`, trusted: true, remember: true, savePath: parent });
    }
    opts.push(
        { label: "Trust for this session only", trusted: true, remember: false, savePath: path },
        { label: "Don't trust", trusted: false, remember: true, savePath: path },
    );
    return opts;
}
