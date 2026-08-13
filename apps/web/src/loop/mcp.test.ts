import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  addMcpServer,
  readMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  startMcpLogin,
  supportsMcp,
} from "./mcp";

const globals = globalThis as { window?: Window & typeof globalThis };

interface Recorded {
  readonly method: string;
  readonly params: unknown;
}

/** Runs a reader/writer against a stubbed bridge and reports what reached loop. */
function withLoop(answers: Record<string, unknown>, options: { throwOn?: string } = {}) {
  const calls: Recorded[] = [];
  globals.window ??= globals as unknown as Window & typeof globalThis;
  window.loop = {
    call: (method, params) => {
      calls.push({ method, params });
      if (options.throwOn === method) return Promise.reject(new Error(`Method not found: ${method}`));
      return Promise.resolve(answers[method] ?? {});
    },
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
  };
  return calls;
}

afterEach(() => {
  delete globals.window?.loop;
});

describe("reading MCP servers", () => {
  it("passes the overview through when loop answers with one", async () => {
    withLoop({
      "mcp.list": {
        enabled: true,
        connected: false,
        projectConfigPath: "/w/project/.loop/mcp.json",
        servers: [{ name: "fs", scope: "global", transport: "stdio", status: "connecting" }],
      },
    });
    const overview = await readMcpServers("/w/project");
    expect(overview?.servers).toHaveLength(1);
    expect(overview?.connected).toBe(false);
  });

  it("answers null on an older loop rather than taking the settings page down", async () => {
    // `mcp.list` is a 'Method not found' there, and a thrown error inside a
    // settings panel unmounts the whole screen.
    withLoop({}, { throwOn: "mcp.list" });
    expect(await readMcpServers(null)).toBeNull();
  });

  it("treats a reply that is not a server list as no answer", async () => {
    withLoop({ "mcp.list": { enabled: true } });
    expect(await readMcpServers(null)).toBeNull();
  });
});

describe("the capability handshake", () => {
  it("is true when loop advertises mcp.list", async () => {
    withLoop({ "server.info": { methods: ["session.list", "mcp.list"] } });
    expect(await supportsMcp()).toBe(true);
  });

  it("is false when it does not", async () => {
    withLoop({ "server.info": { methods: ["session.list"] } });
    expect(await supportsMcp()).toBe(false);
  });

  it("fails OPEN when the handshake itself fails", async () => {
    // A missing `server.info` is a transport problem, not proof MCP is absent
    // — hiding the page then would be a confident lie.
    withLoop({}, { throwOn: "server.info" });
    expect(await supportsMcp()).toBe(true);
  });
});

describe("writing", () => {
  it("sends the scope, so a project server does not land in global settings", async () => {
    const calls = withLoop({});
    await addMcpServer({
      cwd: "/w/project",
      name: "fs",
      scope: "project",
      config: { type: "stdio", command: "npx", args: ["-y", "server-fs"] },
    });
    expect(calls[0]?.params).toMatchObject({
      cwd: "/w/project",
      name: "fs",
      scope: "project",
      config: { type: "stdio", command: "npx" },
    });
  });

  it("reports what loop did rather than assuming success", async () => {
    withLoop({ "mcp.remove": { ok: false } });
    expect(await removeMcpServer(null, "ghost", "global")).toBe(false);
  });

  it("carries the toggle value and scope together", async () => {
    const calls = withLoop({ "mcp.setEnabled": { ok: true } });
    expect(await setMcpServerEnabled("/w/p", "fs", "project", false)).toBe(true);
    expect(calls[0]?.params).toMatchObject({ name: "fs", scope: "project", value: false });
  });
});

describe("the OAuth login", () => {
  it("hands back the id to poll", async () => {
    withLoop({ "mcp.login.start": { flowId: "abc123", server: "figma" } });
    expect(await startMcpLogin(null, "figma")).toBe("abc123");
  });

  it("throws when loop starts no flow, so the panel does not poll forever", async () => {
    withLoop({ "mcp.login.start": {} });
    await expect(startMcpLogin(null, "figma")).rejects.toThrow(/did not start/);
  });

  it("sends the cwd, so a project server can be signed into before it connects", async () => {
    // loop finds the config on disk when it has not connected the server yet,
    // and a project-scoped one only exists relative to a repo.
    const calls = withLoop({ "mcp.login.start": { flowId: "abc123", server: "figma" } });
    await startMcpLogin("/w/project", "figma");
    expect(calls[0]?.params).toMatchObject({ name: "figma", cwd: "/w/project" });
  });
});
