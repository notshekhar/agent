import { afterEach, describe, expect, test } from "bun:test";
import { daemonInvocation, GATEWAY_DAEMON_ENV, GATEWAY_PARENT_ENV, spawnGatewayDaemon } from "../src/gateway-daemon";

// A gateway daemon re-invokes loop as `loop gateways <id>`. Get that argv wrong
// and the child doesn't run the daemon at all — it lands in the interactive
// TUI, which spawns a daemon for every enabled gateway on startup, which lands
// in a TUI… A real run reached 212 processes in five minutes.
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

describe("daemon env markers", () => {
    test("are distinct, so the recursion guard can't be confused for the watchdog", () => {
        expect(GATEWAY_DAEMON_ENV).not.toBe(GATEWAY_PARENT_ENV);
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
        expect(spawnGatewayDaemon("telegram", { ownerPid: process.pid })).toBe("refused-nested");
        // Any gateway, not just the one this process serves.
        expect(spawnGatewayDaemon("slack")).toBe("refused-nested");
    });
});
