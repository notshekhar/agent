/**
 * The download route: fetch a release archive built for THIS machine, unpack it
 * into ~/.loop/servers/<key>/, and hand back the binary inside. Used for the
 * servers that ship as a prebuilt release and belong to no package manager we
 * can lean on — zls, clangd, lua-language-server, terraform-ls, texlab,
 * tinymist, jdtls.
 *
 * Everything a server needs is declared as data on its registry entry (see
 * `DownloadSpec`), so adding one is a table edit, not a new code path — and a
 * user can add their own in ~/.loop/servers/servers.json.
 *
 * Three rules hold for every server here:
 *
 * 1. Decide before the network. The platform/arch maps are the allowlist: a
 *    machine the project doesn't publish for (linux-ia32, say) resolves to no
 *    asset name and returns null without opening a socket. Better a silent "no
 *    server" than a 404 or a half-written archive.
 * 2. Never trust the layout. Release archives disagree about whether they wrap
 *    their contents in a top-level directory, and they change their minds
 *    between versions. `locateBinary` tries the declared path, then a glob, then
 *    a bounded search — so a repackaged release doesn't silently break.
 * 3. The version is part of the identity. A marker file records what was
 *    installed; when the registry asks for something else the old tree is
 *    removed rather than shadowing the new one.
 */
import { getConfigDir } from "../../../brand";
import { spawn } from "node:child_process";
import {
    chmodSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SERVERS_DIR = join(getConfigDir(), "servers");
const MARKER = ".loop-download.json";
const FETCH_TIMEOUT_MS = 20_000;
/**
 * Downloads are bounded by SILENCE, not by total duration. Eclipse serves the
 * 28MB jdtls snapshot from mirrors that run at ~120KB/s — four minutes of
 * perfectly healthy transfer — so any wall-clock cap generous enough for a slow
 * mirror is too generous to catch a dead socket. Resetting on every chunk gets
 * both: a stalled connection dies in a minute, a slow one is left alone.
 */
const STALL_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 180_000;
/** Depth for the last-resort search for a binary the declared path missed. */
const SEARCH_MAX_DEPTH = 4;

/** Where the release (and its version) is looked up. */
export type ReleaseSource =
    /** GET api.github.com/repos/<repo>/releases/latest */
    | { kind: "github"; repo: string }
    /** GET api.releases.hashicorp.com/v1/releases/<product>/latest — structured builds[] */
    | { kind: "hashicorp"; product: string }
    /** No lookup at all: `url` is fixed (a rolling "latest" tarball). */
    | { kind: "static" };

/**
 * How to get a prebuilt server for this machine.
 *
 * Template variables usable in `asset`, `url` and `bin`:
 *   {version}  release version, leading "v" stripped
 *   {target}   this platform's entry from `targets`, with {arch} substituted
 *   {arch}     this arch's entry from `archs`
 *   {ext}      "zip" on Windows, `format` elsewhere
 *   {exe}      ".exe" on Windows, "" elsewhere
 */
export interface DownloadSpec {
    source: ReleaseSource;
    /**
     * Exact asset name to match against a GitHub release's assets. Exact rather
     * than substring on purpose: tinymist's release also carries `typlite-`,
     * `tinymist-viewer-` and `tinymist-docs-tool-` builds of the same triple,
     * and a substring match picks whichever GitHub happens to list first.
     */
    asset?: string;
    /** Full URL template. Used when the archive isn't a GitHub release asset. */
    url?: string;
    /** process.platform → the project's own word for it. May contain {arch}. */
    targets?: Record<string, string>;
    /** process.arch → the project's own word for it. */
    archs?: Record<string, string>;
    /** Archive format on non-Windows. Windows is assumed zip. */
    format?: "tar.gz" | "tar.xz" | "zip";
    /**
     * `platform-arch` pairs (node's vocabulary, e.g. "linux-ia32") that the maps
     * would happily name but upstream doesn't actually publish.
     */
    unsupported?: string[];
    /**
     * Path to the binary inside the unpacked tree. One `*` is allowed (jdtls's
     * launcher jar carries a build stamp). A per-platform record covers projects
     * that ship a differently-named entry point per OS.
     */
    bin: string | Record<string, string>;
}

/** A provisioned server: where it was unpacked, and the binary within. */
export interface Downloaded {
    dir: string;
    bin: string;
}

interface Marker {
    version: string;
    bin: string;
}

const inFlight = new Map<string, Promise<Downloaded | null>>();

const isWin = () => process.platform === "win32";
const exeSuffix = () => (isWin() ? ".exe" : "");

function fill(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/**
 * This machine's tokens in the project's vocabulary, or null when the project
 * doesn't build for it. Returning null here is what keeps an unsupported
 * platform from ever reaching the network.
 */
export function resolveTarget(spec: DownloadSpec): { target: string; arch: string; ext: string } | null {
    const { platform, arch: nodeArch } = process;
    if (spec.unsupported?.includes(`${platform}-${nodeArch}`)) return null;

    const arch = spec.archs ? spec.archs[nodeArch] : nodeArch;
    if (spec.archs && arch === undefined) return null;

    // A spec with no `targets` is arch- and OS-independent (jdtls is pure Java).
    const rawTarget = spec.targets ? spec.targets[platform] : "";
    if (spec.targets && rawTarget === undefined) return null;

    const ext = isWin() ? "zip" : (spec.format ?? "tar.gz");
    return { target: fill(rawTarget ?? "", { arch: arch ?? nodeArch }), arch: arch ?? nodeArch, ext };
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
    try {
        const res = await fetch(url, {
            // GitHub rejects requests without one, and the accept header pins the
            // response shape across API versions.
            headers: { "User-Agent": "loop-lsp", Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        return (await res.json()) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** The release version and, where the source knows it, the exact archive URL. */
async function resolveRelease(
    spec: DownloadSpec,
    target: { target: string; arch: string; ext: string },
): Promise<{ version: string; url: string } | null> {
    const vars = { target: target.target, arch: target.arch, ext: target.ext, exe: exeSuffix() };

    if (spec.source.kind === "static") {
        if (!spec.url) return null;
        // Nothing to version against: a rolling URL is identified by its own text,
        // so a changed URL in the registry invalidates the install.
        return { version: "latest", url: fill(spec.url, { ...vars, version: "latest" }) };
    }

    if (spec.source.kind === "hashicorp") {
        const json = await fetchJson(`https://api.releases.hashicorp.com/v1/releases/${spec.source.product}/latest`);
        const version = typeof json?.version === "string" ? json.version : null;
        const builds = Array.isArray(json?.builds)
            ? (json.builds as { os?: string; arch?: string; url?: string }[])
            : [];
        if (!version) return null;
        // Structured index — no filename guessing, which is why this is preferred
        // wherever a project publishes one.
        const build = builds.find((b) => b.os === target.target && b.arch === target.arch);
        return build?.url ? { version, url: build.url } : null;
    }

    const json = await fetchJson(`https://api.github.com/repos/${spec.source.repo}/releases/latest`);
    const tag = typeof json?.tag_name === "string" ? json.tag_name : null;
    if (!tag) return null;
    const version = tag.replace(/^v/, "");
    const full = { ...vars, version };

    if (spec.url) return { version, url: fill(spec.url, full) };
    if (!spec.asset) return null;

    const wanted = fill(spec.asset, full);
    const assets = Array.isArray(json?.assets)
        ? (json.assets as { name?: string; browser_download_url?: string }[])
        : [];
    const asset = assets.find((a) => a.name === wanted);
    return asset?.browser_download_url ? { version, url: asset.browser_download_url } : null;
}

async function download(url: string, dest: string): Promise<boolean> {
    const control = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One deadline covers connecting and every subsequent chunk; each chunk
    // pushes it out again, so only actual silence aborts.
    const restart = () => {
        clearTimeout(timer);
        timer = setTimeout(() => control.abort(), STALL_TIMEOUT_MS);
    };

    try {
        restart();
        const res = await fetch(url, { headers: { "User-Agent": "loop-lsp" }, signal: control.signal });
        if (!res.ok || !res.body) return false;

        // Streamed rather than buffered: these run to tens of megabytes, and a
        // language server starting up shouldn't spike the agent's memory. The
        // cast bridges the DOM ReadableStream in lib.dom to the node:stream one.
        type WebStream = Parameters<typeof Readable.fromWeb>[0];
        const body = Readable.fromWeb(res.body as unknown as WebStream);
        // A pass-through purely to observe progress — attaching a "data"
        // listener to `body` itself would put it in flowing mode behind
        // pipeline's back and drop the first chunks on the floor.
        const progress = new PassThrough();
        progress.on("data", restart);

        await pipeline(body, progress, createWriteStream(dest), { signal: control.signal });
        return statSync(dest).size > 0;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn(command, args, { cwd, stdio: "ignore" });
        const timer = setTimeout(() => {
            proc.kill();
            resolve(false);
        }, timeoutMs);
        proc.on("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
        proc.on("exit", (code) => {
            clearTimeout(timer);
            resolve(code === 0);
        });
    });
}

/**
 * Unpack in place. No archive library: `tar` is present on every platform we
 * target (including Windows 10+), and for zip we use what the OS ships —
 * PowerShell's Expand-Archive on Windows, `unzip` elsewhere. Since every spec
 * resolves to `.zip` on Windows, the tar path is never Windows-only work.
 */
async function extract(archive: string, dir: string): Promise<boolean> {
    if (archive.endsWith(".zip")) {
        if (isWin()) {
            // ProgressPreference silences the progress overlay, which would
            // otherwise scribble over the TUI.
            const cmd = `$global:ProgressPreference='SilentlyContinue'; Expand-Archive -Path '${archive}' -DestinationPath '${dir}' -Force`;
            return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], dir, EXTRACT_TIMEOUT_MS);
        }
        return run("unzip", ["-o", "-q", archive, "-d", dir], dir, EXTRACT_TIMEOUT_MS);
    }
    // -xf detects gzip and xz on both bsdtar and GNU tar.
    return run("tar", ["-xf", archive], dir, EXTRACT_TIMEOUT_MS);
}

/** Files under `dir`, breadth-first, bounded — the fallback for a moved binary. */
function findByName(dir: string, name: string): string | null {
    const queue: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
    while (queue.length > 0) {
        const { path, depth } = queue.shift()!;
        let entries: import("node:fs").Dirent[];
        try {
            entries = readdirSync(path, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = join(path, entry.name);
            if (entry.isDirectory()) {
                if (depth < SEARCH_MAX_DEPTH) queue.push({ path: full, depth: depth + 1 });
            } else if (entry.name === name) {
                return full;
            }
        }
    }
    return null;
}

/** Resolve a `bin` template that contains a single `*`. */
function resolveGlob(dir: string, pattern: string): string | null {
    const slash = pattern.lastIndexOf("/");
    const parent = slash === -1 ? dir : join(dir, pattern.slice(0, slash));
    const leaf = slash === -1 ? pattern : pattern.slice(slash + 1);
    const [prefix, suffix] = leaf.split("*", 2);
    try {
        const hit = readdirSync(parent)
            .filter((f) => f.startsWith(prefix) && f.endsWith(suffix ?? ""))
            .sort()
            .pop();
        return hit ? join(parent, hit) : null;
    } catch {
        return null;
    }
}

/**
 * Where the binary actually landed. Release archives disagree about wrapping
 * their contents in a top-level directory and change their minds between
 * versions, so the declared path is a hint, not a contract.
 */
export function locateBinary(dir: string, spec: DownloadSpec, vars: Record<string, string>): string | null {
    const declared = typeof spec.bin === "string" ? spec.bin : spec.bin[process.platform];
    if (!declared) return null;
    const rel = fill(declared, vars);

    if (rel.includes("*")) return resolveGlob(dir, rel);

    const exact = join(dir, rel);
    if (existsSync(exact)) return exact;
    // Same name, somewhere else in the tree — an archive that grew (or dropped)
    // a top-level directory.
    return findByName(dir, basename(rel));
}

function readMarker(dir: string): Marker | null {
    try {
        return JSON.parse(readFileSync(join(dir, MARKER), "utf-8")) as Marker;
    } catch {
        return null;
    }
}

/**
 * Ensure a downloadable server is present, and return the binary.
 *
 * Resolution order: an install recorded by a previous run (verified to still be
 * on disk) wins outright and costs no network. Otherwise the release is looked
 * up, and an install of a different version is torn down before the new one is
 * unpacked.
 */
export function ensureDownloaded(key: string, spec: DownloadSpec): Promise<Downloaded | null> {
    const dir = join(SERVERS_DIR, key);
    const existing = readMarker(dir);
    if (existing && existsSync(existing.bin)) return Promise.resolve({ dir, bin: existing.bin });

    const running = inFlight.get(key);
    if (running) return running;

    const job = install(dir, spec).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
}

async function install(dir: string, spec: DownloadSpec): Promise<Downloaded | null> {
    const target = resolveTarget(spec);
    if (!target) return null; // no build for this machine — never hits the network

    const release = await resolveRelease(spec, target);
    if (!release) return null;

    const vars = {
        version: release.version,
        target: target.target,
        arch: target.arch,
        ext: target.ext,
        exe: exeSuffix(),
    };

    try {
        // A stale tree of a different version must not shadow the new one — and
        // a half-extracted tree from an interrupted run must not either.
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });

        const archive = join(dir, `archive.${target.ext}`);
        if (!(await download(release.url, archive))) return null;
        if (!(await extract(archive, dir))) return null;
        rmSync(archive, { force: true });

        const bin = locateBinary(dir, spec, vars);
        if (!bin) return null;

        // zip carries no Unix permission bits, so an unpacked binary comes out
        // non-executable on mac and Linux.
        if (!isWin()) {
            try {
                chmodSync(bin, 0o755);
            } catch {
                return null;
            }
        }

        writeFileSync(join(dir, MARKER), JSON.stringify({ version: release.version, bin } satisfies Marker));
        return { dir, bin };
    } catch {
        return null;
    }
}

/**
 * jdtls isn't a binary — it's an Equinox launcher jar plus a per-platform
 * configuration directory and a scratch data directory, so its command line has
 * to be built after the archive is on disk.
 *
 * The config directory is chosen by probing rather than by a platform table:
 * recent snapshots ship `config_mac_arm` and `config_linux_arm` alongside the
 * x86 ones, and picking the x86 config on Apple Silicon starts a JVM that
 * quietly fails to load the native bits.
 */
export function javaConfigDir(dir: string): string | null {
    const base =
        process.platform === "darwin" ? "config_mac" : process.platform === "win32" ? "config_win" : "config_linux";
    const candidates = process.arch === "arm64" ? [`${base}_arm`, base] : [base];
    for (const name of candidates) {
        if (existsSync(join(dir, name))) return join(dir, name);
    }
    return null;
}

/** A fresh Eclipse workspace per launch; jdtls corrupts a shared one. */
export function javaDataDir(): string {
    return mkdtempSync(join(tmpdir(), "loop-jdtls-"));
}
