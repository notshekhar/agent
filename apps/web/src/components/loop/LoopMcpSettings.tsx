/**
 * MCP — the GUI form of the terminal's `/mcp` panel.
 *
 * Same reach as the terminal: list with live status, add, enable/disable,
 * delete, reconnect, and the OAuth browser login. All of it is loop's, done
 * loop-side (`packages/core/src/mcp`); this is the surface.
 *
 * The one deliberate difference from the TUI: the list draws from
 * CONFIGURATION first and says "not connected yet", because connecting is up
 * to 30s per server and a settings page that hangs half a minute before
 * showing anything is worse than one that shows the servers and offers to
 * connect them.
 */
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  Loader2Icon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import {
  addMcpServer,
  cancelMcpLogin,
  pollMcpLogin,
  readMcpServers,
  refreshMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  startMcpLogin,
  type McpOverview,
  type McpScope,
  type McpServer,
  type McpServerInput,
  type McpStatus,
} from "../../loop/mcp";
import { readLocalApi } from "../../localApi";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/** Wording lifted from the TUI panel so the two surfaces read the same. */
const STATUS_LABEL: Readonly<Record<McpStatus, string>> = {
  ready: "ready",
  connecting: "connecting…",
  disabled: "disabled",
  error: "error",
  "needs-auth": "needs authorization",
};

const STATUS_CLASS: Readonly<Record<McpStatus, string>> = {
  ready: "text-success",
  connecting: "text-muted-foreground",
  disabled: "text-muted-foreground",
  error: "text-destructive",
  "needs-auth": "text-warning",
};

function StatusIcon({ status }: { status: McpStatus }) {
  if (status === "ready") return <CheckCircle2Icon className="size-3.5" aria-hidden />;
  if (status === "connecting") return <Loader2Icon className="size-3.5 animate-spin" aria-hidden />;
  if (status === "needs-auth") return <KeyRoundIcon className="size-3.5" aria-hidden />;
  if (status === "error") return <AlertTriangleIcon className="size-3.5" aria-hidden />;
  return <PlugIcon className="size-3.5" aria-hidden />;
}

/** What a row says under its name: tools when connected, the reason when not. */
function detailOf(server: McpServer, connected: boolean): string {
  if (server.status === "ready") {
    return `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
  }
  if (server.status === "error" && server.error) return server.error;
  if (!connected && server.enabled) return "not connected yet";
  return STATUS_LABEL[server.status];
}

function transportOf(server: McpServer): string {
  return server.transport === "stdio" ? (server.command ?? "stdio") : (server.url ?? server.transport);
}

interface AddForm {
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly command: string;
  readonly args: string;
  readonly url: string;
  readonly oauth: boolean;
  readonly scope: McpScope;
}

const EMPTY_FORM: AddForm = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  oauth: true,
  scope: "global",
};

function configOf(form: AddForm): McpServerInput {
  if (form.transport === "stdio") {
    const args = form.args.trim() ? form.args.trim().split(/\s+/) : undefined;
    return { type: "stdio", command: form.command.trim(), ...(args ? { args } : {}) };
  }
  return {
    type: form.transport,
    url: form.url.trim(),
    ...(form.oauth ? { auth: "oauth" as const } : {}),
  };
}

export function LoopMcpSettings() {
  const [overview, setOverview] = useState<McpOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [loginLog, setLoginLog] = useState<{ server: string; lines: string[] } | null>(null);
  // A login outlives any one render; the poller reads it through a ref so a
  // re-render cannot start a second loop against the same flow.
  const loginRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const result = await readMcpServers(null);
    setOverview(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await action();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const reconnect = useCallback(
    (name?: string) =>
      run(name ?? "__all__", async () => {
        const result = await refreshMcpServers(null, name);
        if (result) setOverview(result);
      }),
    [run],
  );

  /**
   * The browser login: loop hands back a URL, the shell opens it, and the flow
   * is polled until it lands. Cancelling stops the polling — the browser half
   * cannot be recalled, and the panel says as much rather than pretending.
   */
  const authorize = useCallback(
    async (name: string) => {
      setError(null);
      setLoginLog({ server: name, lines: ["Starting authorization…"] });
      let flowId: string;
      try {
        flowId = await startMcpLogin(null, name);
      } catch (err) {
        setLoginLog(null);
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      loginRef.current = flowId;

      let cursor = 0;
      for (;;) {
        if (loginRef.current !== flowId) return;
        const poll = await pollMcpLogin(null, flowId, cursor);
        if (!poll) break;
        cursor = poll.cursor;
        for (const event of poll.events) {
          if (event.type === "auth") {
            setLoginLog((current) =>
              current ? { ...current, lines: [...current.lines, "Opening your browser…"] } : current,
            );
            void readLocalApi()?.shell.openExternal(event.url).catch(() => undefined);
          } else {
            setLoginLog((current) =>
              current ? { ...current, lines: [...current.lines, event.message] } : current,
            );
          }
        }
        if (poll.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      loginRef.current = null;
      await load();
    },
    [load],
  );

  const submit = useCallback(async () => {
    const name = form.name.trim();
    if (!name) {
      setError("A server needs a name.");
      return;
    }
    await run("__add__", async () => {
      await addMcpServer({ cwd: null, name, scope: form.scope, config: configOf(form) });
      setForm(EMPTY_FORM);
      setAdding(false);
    });
  }, [form, run]);

  const servers = overview?.servers ?? [];
  const connected = overview?.connected ?? false;

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="mcp"
        title="MCP servers"
        icon={<PlugIcon className="size-4" aria-hidden />}
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void reconnect()}
            >
              <RefreshCwIcon className={cn("size-3.5", busy === "__all__" && "animate-spin")} />
              {connected ? "Reconnect all" : "Connect"}
            </Button>
            <Button size="sm" onClick={() => setAdding((value) => !value)}>
              <PlusIcon className="size-3.5" />
              Add server
            </Button>
          </div>
        }
      >
        {overview === null && !loading ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground sm:px-4">
            This loop cannot manage MCP servers — it predates the <code>mcp.*</code> methods.
            Update loop and reopen this page.
          </p>
        ) : null}

        {overview !== null && !overview.enabled ? (
          <p className="px-3 py-3 text-[13px] text-warning sm:px-4">
            MCP is switched off in loop&rsquo;s settings, so none of these servers load. Turn
            <code> mcp </code> back on in General.
          </p>
        ) : null}

        {error ? (
          <p className="px-3 py-2 text-[13px] text-destructive sm:px-4" role="alert">
            {error}
          </p>
        ) : null}

        {adding ? (
          <div className="mx-3 mb-3 space-y-3 rounded-xl border border-border/70 p-4 sm:mx-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-name">Name</Label>
                <Input
                  id="mcp-name"
                  value={form.name}
                  placeholder="filesystem"
                  onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-transport">Transport</Label>
                <div className="flex gap-1" id="mcp-transport">
                  {(["stdio", "http", "sse"] as const).map((option) => (
                    <Button
                      key={option}
                      size="sm"
                      variant={form.transport === option ? "default" : "outline"}
                      onClick={() => setForm((f) => ({ ...f, transport: option }))}
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              </div>
            </div>

            {form.transport === "stdio" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-command">Command</Label>
                  <Input
                    id="mcp-command"
                    value={form.command}
                    placeholder="npx"
                    onChange={(event) => setForm((f) => ({ ...f, command: event.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-args">Arguments</Label>
                  <Input
                    id="mcp-args"
                    value={form.args}
                    placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                    onChange={(event) => setForm((f) => ({ ...f, args: event.target.value }))}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-url">URL</Label>
                  <Input
                    id="mcp-url"
                    value={form.url}
                    placeholder="https://example.com/mcp"
                    onChange={(event) => setForm((f) => ({ ...f, url: event.target.value }))}
                  />
                </div>
                <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Switch
                    checked={form.oauth}
                    onCheckedChange={(value) => setForm((f) => ({ ...f, oauth: value === true }))}
                  />
                  Sign in with OAuth in the browser
                </label>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Switch
                  checked={form.scope === "project"}
                  onCheckedChange={(value) =>
                    setForm((f) => ({ ...f, scope: value === true ? "project" : "global" }))
                  }
                />
                Only this project
                {overview?.projectConfigPath ? (
                  <span className="truncate font-mono text-[11px] opacity-70">
                    {overview.projectConfigPath}
                  </span>
                ) : null}
              </label>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={busy === "__add__"} onClick={() => void submit()}>
                  {busy === "__add__" ? "Connecting…" : "Add and connect"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {loginLog ? (
          <div className="mx-3 mb-3 space-y-2 rounded-xl border border-border/70 p-4 sm:mx-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Authorizing {loginLog.server}</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const flowId = loginRef.current;
                  loginRef.current = null;
                  if (flowId) void cancelMcpLogin(null, flowId);
                  setLoginLog(null);
                }}
              >
                Close
              </Button>
            </div>
            <ul className="space-y-0.5 text-[13px] text-muted-foreground">
              {loginLog.lines.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {loading ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground sm:px-4">Loading…</p>
        ) : null}

        {!loading && overview !== null && servers.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground sm:px-4">
            No MCP servers configured. Add one above — it is the same list the terminal&rsquo;s{" "}
            <code>/mcp</code> shows.
          </p>
        ) : null}

        <div className="divide-y divide-border/50">
          {servers.map((server) => (
            <div key={`${server.scope}:${server.name}`} className="px-3 py-3 sm:px-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-foreground">{server.name}</h3>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-xs",
                        STATUS_CLASS[server.status],
                      )}
                    >
                      <StatusIcon status={server.status} />
                      {STATUS_LABEL[server.status]}
                    </span>
                    {server.scope === "project" ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        project
                      </span>
                    ) : null}
                  </div>
                  <p className="truncate font-mono text-[12px] text-muted-foreground/80">
                    {transportOf(server)}
                  </p>
                  <p className="text-[12px] text-muted-foreground">
                    {detailOf(server, connected)}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {server.oauth ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={loginRef.current !== null}
                      onClick={() => void authorize(server.name)}
                    >
                      <KeyRoundIcon className="size-3.5" />
                      {server.authorized ? "Re-authorize" : "Authorize"}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void reconnect(server.name)}
                  >
                    <RefreshCwIcon
                      className={cn("size-3.5", busy === server.name && "animate-spin")}
                    />
                    Reconnect
                  </Button>
                  <Switch
                    checked={server.enabled}
                    aria-label={`${server.name} enabled`}
                    disabled={busy !== null}
                    onCheckedChange={(value) =>
                      void run(server.name, () =>
                        setMcpServerEnabled(null, server.name, server.scope, value === true),
                      )
                    }
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Delete ${server.name}`}
                    disabled={busy !== null}
                    onClick={() =>
                      void run(server.name, () =>
                        removeMcpServer(null, server.name, server.scope),
                      )
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>

              {server.tools && server.tools.length > 0 ? (
                <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground/70">
                  {server.tools.join("  ")}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
