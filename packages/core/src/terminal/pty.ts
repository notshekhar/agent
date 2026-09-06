/**
 * A pseudo-terminal, built on `openpty(3)` through `bun:ffi`.
 *
 * node-pty is not an option: under Bun its libuv socket pump never fires, so
 * data and exit events simply never arrive. (The desktop app can use it because
 * that runs on Electron/Node; the CLI cannot.) Everything here is shaped by
 * that constraint and by three further Bun facts, each marked at its site.
 */
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";
import { createReadStream } from "node:fs";
import { write as fsWrite, close as fsClose } from "node:fs";

/** `struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; }` */
function winsize(rows: number, cols: number): Uint16Array {
    return new Uint16Array([Math.max(1, rows), Math.max(1, cols), 0, 0]);
}

// _IOR('t', 104, struct winsize) / _IOW('t', 103, struct winsize). Same values
// on macOS and Linux.
const TIOCGWINSZ = 0x40087468n;
const TIOCSWINSZ = 0x80087467n;

type PtyLib = {
    openpty(amaster: unknown, aslave: unknown, name: unknown, termp: unknown, winp: unknown): number;
    ioctl(fd: number, request: bigint, arg: unknown): number;
    ioctlPadded(fd: number, request: bigint, ...rest: unknown[]): number;
};

let lib: PtyLib | undefined;
let libError: string | undefined;

/**
 * `openpty` lives in libutil on Linux and in libSystem on macOS.
 */
function libCandidates(): string[] {
    if (process.platform === "darwin") return ["libSystem.B.dylib"];
    return [`libutil.${suffix}.1`, `libutil.${suffix}`, `libc.${suffix}.6`];
}

const IOCTL_PLAIN = [FFIType.int, FFIType.u64, FFIType.ptr] as const;
/**
 * `ioctl` is variadic, and on Apple arm64 every variadic argument is passed on
 * the STACK while bun:ffi passes declared arguments in registers — so the plain
 * three-argument form hands the callee a garbage pointer. It still returns 0,
 * which is the dangerous part: a resize silently does nothing.
 *
 * Declaring eight leading arguments pushes the ninth onto the stack, exactly
 * where the callee looks for the first variadic one. Other ABIs (x86-64, Linux
 * arm64) pass variadic arguments in registers and want the plain form, so which
 * one is correct is decided by probing rather than by guessing the platform.
 */
const IOCTL_PADDED = [
    FFIType.int,
    FFIType.u64,
    FFIType.i64,
    FFIType.i64,
    FFIType.i64,
    FFIType.i64,
    FFIType.i64,
    FFIType.i64,
    FFIType.ptr,
] as const;

function loadLib(): PtyLib | undefined {
    if (lib || libError) return lib;
    for (const name of libCandidates()) {
        try {
            const plain = dlopen(name, {
                openpty: {
                    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
                    returns: FFIType.int,
                },
                ioctl: { args: IOCTL_PLAIN as never, returns: FFIType.int },
            });
            const padded = dlopen(name, { ioctl: { args: IOCTL_PADDED as never, returns: FFIType.int } });
            lib = {
                openpty: plain.symbols.openpty as PtyLib["openpty"],
                ioctl: plain.symbols.ioctl as PtyLib["ioctl"],
                ioctlPadded: padded.symbols.ioctl as PtyLib["ioctlPadded"],
            };
            return lib;
        } catch {
            // try the next candidate
        }
    }
    libError = `openpty not available (tried ${libCandidates().join(", ")})`;
    return undefined;
}

/** Which ioctl calling form actually works here; decided once, by experiment. */
let paddedIoctl: boolean | undefined;

function callIoctl(l: PtyLib, fd: number, request: bigint, arg: Uint16Array): number {
    const Z = 0n;
    return paddedIoctl ? l.ioctlPadded(fd, request, Z, Z, Z, Z, Z, Z, ptr(arg)) : l.ioctl(fd, request, ptr(arg));
}

/**
 * Decide the ioctl form by round-tripping a real winsize through a throwaway
 * pty: set a size, read it back, and keep whichever form returns what it wrote.
 * Guessing from `process.arch` would be a guess about a calling convention,
 * which is precisely the thing that already failed silently once.
 */
function probeIoctlForm(l: PtyLib): void {
    if (paddedIoctl !== undefined) return;
    const master = new Int32Array(1);
    const slave = new Int32Array(1);
    if (l.openpty(ptr(master), ptr(slave), null, null, ptr(winsize(24, 80))) !== 0) {
        paddedIoctl = process.platform === "darwin" && process.arch === "arm64";
        return;
    }
    try {
        for (const padded of [false, true]) {
            paddedIoctl = padded;
            callIoctl(l, master[0], TIOCSWINSZ, winsize(41, 121));
            const back = new Uint16Array(4);
            callIoctl(l, master[0], TIOCGWINSZ, back);
            if (back[0] === 41 && back[1] === 121) return;
        }
        paddedIoctl = false;
    } finally {
        fsClose(master[0], () => {});
        fsClose(slave[0], () => {});
    }
}

export interface PtyOptions {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    rows?: number;
    cols?: number;
}

export interface Pty {
    write(data: string): void;
    resize(rows: number, cols: number): void;
    kill(): void;
    readonly exited: boolean;
    onData(fn: (chunk: string) => void): void;
    onExit(fn: (code: number) => void): void;
}

export function ptyAvailable(): boolean {
    return loadLib() !== undefined;
}

export function ptyUnavailableReason(): string | undefined {
    loadLib();
    return libError;
}

export function spawnPty(options: PtyOptions): Pty {
    const l = loadLib();
    if (!l) throw new Error(libError ?? "openpty not available");
    probeIoctlForm(l);

    const master = new Int32Array(1);
    const slave = new Int32Array(1);
    const rows = options.rows ?? 24;
    const cols = options.cols ?? 80;
    // The initial size rides on openpty's winsize argument, which is a normal
    // (non-variadic) parameter and so is always passed correctly.
    if (l.openpty(ptr(master), ptr(slave), null, null, ptr(winsize(rows, cols))) !== 0) {
        throw new Error("openpty failed");
    }
    const masterFd = master[0];
    const slaveFd = slave[0];

    const dataFns: ((chunk: string) => void)[] = [];
    const exitFns: ((code: number) => void)[] = [];
    let exited = false;

    const child = Bun.spawn([options.cmd, ...(options.args ?? [])], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, TERM: options.env?.TERM ?? "xterm-256color" },
        stdio: [slaveFd as never, slaveFd as never, slaveFd as never],
        onExit(_proc, code) {
            if (exited) return;
            exited = true;
            for (const fn of exitFns) fn(code ?? 0);
        },
    });

    // Read through node:fs (libuv's threadpool), never a synchronous FFI read in
    // a poll loop: that starves process.stdin, and Bun silently stops delivering
    // keystrokes to the app itself.
    // autoClose so the stream closes the master itself, once its in-flight read
    // has finished. Closing the fd by hand while a threadpool read is still
    // outstanding lets the NEXT openpty be handed the same fd number — and the
    // dead reader then steals that new terminal's output. It surfaces as a
    // terminal that intermittently shows nothing, only after another one was
    // closed, which is close to unfindable from the symptom.
    const reader = createReadStream("", { fd: masterFd, autoClose: true, highWaterMark: 64 * 1024 });
    reader.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const fn of dataFns) fn(text);
    });
    // EIO on the master is the normal end of a pty once the child is gone.
    reader.on("error", () => {});

    // Writes are queued and drained one at a time: concurrent async writes to
    // the master reorder, which scrambles multi-chunk input ("echo" arriving as
    // "ech" + "o").
    let writing = false;
    const queue: string[] = [];
    const drain = (): void => {
        if (writing || queue.length === 0 || exited) return;
        writing = true;
        const next = Buffer.from(queue.shift() ?? "", "utf8");
        fsWrite(masterFd, next, 0, next.length, null, () => {
            writing = false;
            drain();
        });
    };

    return {
        write(data: string) {
            if (exited) return;
            queue.push(data);
            drain();
        },
        resize(r: number, c: number) {
            if (exited) return;
            callIoctl(l, masterFd, TIOCSWINSZ, winsize(r, c));
        },
        kill() {
            if (exited) return;
            exited = true;
            try {
                child.kill();
            } catch {
                // already gone
            }
            // Closes masterFd for us, safely (see the stream's construction).
            reader.destroy();
            // Nothing reads the slave; the child holds its own duplicates.
            fsClose(slaveFd, () => {});
        },
        get exited() {
            return exited;
        },
        onData(fn) {
            dataFns.push(fn);
        },
        onExit(fn) {
            exitFns.push(fn);
        },
    };
}
