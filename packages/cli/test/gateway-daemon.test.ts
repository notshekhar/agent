import { afterEach, describe, expect, test } from "bun:test";
import { daemonInvocation, GATEWAY_DAEMON_ENV, spawnGatewayDaemon } from "../src/gateway-daemon";
import { parseGatewayOwner } from "@notshekhar/loop-core";

// A gateway daemon re-invokes loop as `loop gateways <id>`. Get that argv wrong
// and the child doesn't run the daemon at all — it lands in the interactive
// TUI. That used to spawn a daemon for every enabled gateway on startup, which
// landed in a TUI… a real run reached 212 processes in five minutes. The TUI
// hosts gateways in-process now, but the argv shape still has to be right.
describe("daemonInvocation", () => {
    test("compiled binary passes only the command args", () => {
        const { command, args } = daemonInvocation("/Users/x/.loop-bin/loop", "/$bunfs/root/cli.js", [
            "gateways",
            "telegram",
        ]);
        expect(command).toBe("/Users/x/.loop-bin/loop");
        expect(args).toEqual(["gateways", "telegram"]);
    });

    test("the compiled binary's bunfs entry never leaks into argv", () => {
        // The regression itself: "/$bunfs/root/cli.js" ends in .js, so an
        // argv-based "am I running from source?" test says yes, and the child's
        // command word becomes the bunfs path instead of "gateways".
        const { args } = daemonInvocation("/Users/x/.loop-bin/loop", "/$bunfs/root/cli.js", ["gateways", "telegram"]);
        expect(args.join(" ")).not.toInclude("bunfs");
        expect(args[0]).toBe("gateways");
    });

    test("under bun the entry script leads", () => {
        const { command, args } = daemonInvocation("/opt/homebrew/bin/bun", "/repo/packages/cli/src/cli.ts", [
            "gateways",
            "telegram",
        ]);
        expect(command).toBe("/opt/homebrew/bin/bun");
        expect(args).toEqual(["/repo/packages/cli/src/cli.ts", "gateways", "telegram"]);
    });

    test("bun detection ignores case and version suffixes", () => {
        expect(daemonInvocation("/usr/local/bin/bun-1.2.0", "/e.ts", ["gateways", "x"]).args[0]).toBe("/e.ts");
        expect(daemonInvocation("/C/Bun.exe", "/e.ts", ["gateways", "x"]).args[0]).toBe("/e.ts");
        // A binary that merely *contains* "bun" is not bun.
        expect(daemonInvocation("/Users/x/.bun/bin/loop", "/e.ts", ["gateways", "x"]).args).toEqual(["gateways", "x"]);
    });
});

describe("nested-spawn refusal", () => {
    afterEach(() => {
        delete process.env[GATEWAY_DAEMON_ENV];
    });

    // The guarantee that matters: even if the invocation regressed and a daemon
    // landed somewhere that spawns gateways, the chain stops at depth one. This
    // refusal comes before every other check, so it holds regardless of pidfile
    // state, and it spawns nothing — no process is created to assert against.
    test("a process already running as a gateway daemon refuses to spawn one", () => {
        process.env[GATEWAY_DAEMON_ENV] = "telegram";
        expect(spawnGatewayDaemon("telegram")).toBe("refused-nested");
        // Any gateway, not just the one this process serves.
        expect(spawnGatewayDaemon("slack")).toBe("refused-nested");
    });
});

// The pidfile says WHO owns a gateway and HOW. `loop gateways stop` reads the
// mode to decide whether SIGTERM is safe: right for a daemon that exists only
// to poll, catastrophic for an in-process owner, where the pid is a whole
// interactive loop the user is sitting in.
describe("gateway pidfile ownership", () => {
    test("a JSON record round-trips pid and mode", () => {
        expect(parseGatewayOwner('{"pid":4321,"mode":"in-process"}')).toEqual({ pid: 4321, mode: "in-process" });
        expect(parseGatewayOwner('{"pid":4321,"mode":"daemon"}')).toEqual({ pid: 4321, mode: "daemon" });
    });

    test("a legacy bare-pid file reads as a daemon", () => {
        // Written by an older loop that only had detached daemons. Such a
        // process may still be alive across an upgrade, and must stay stoppable
        // rather than reading as a corrupt pidfile.
        expect(parseGatewayOwner("9182")).toEqual({ pid: 9182, mode: "daemon" });
        expect(parseGatewayOwner(" 9182\n")).toEqual({ pid: 9182, mode: "daemon" });
    });

    test("garbage and impossible pids are rejected, not guessed at", () => {
        // A pid that parses to 0/-1 would make process.kill() signal the
        // process group rather than one process.
        for (const raw of ["", "   ", "not-a-pid", "0", "-1", "{", '{"pid":"x"}', '{"mode":"daemon"}']) {
            expect(parseGatewayOwner(raw)).toBeNull();
        }
    });

    test("an unknown mode falls back to daemon rather than failing the parse", () => {
        expect(parseGatewayOwner('{"pid":7,"mode":"wat"}')).toEqual({ pid: 7, mode: "daemon" });
    });
});
