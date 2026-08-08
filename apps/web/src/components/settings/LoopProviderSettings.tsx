/**
 * The Providers page — loop's providers, signed in to through loop.
 *
 * This replaces the panel the port inherited, which listed the upstream app's
 * *coding agents* (Codex, Cursor, OpenCode) and probed for their CLIs on PATH.
 * loop is not a launcher for other agents; it talks to model providers itself.
 * So the page asks loop what it has (`auth.providers`) and drives loop's own
 * login flows, which means a provider connected here is connected in the
 * terminal too — one credential store, not two.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import type { LoopAuthMethod, LoopLoginMethod } from "../../loop/providers";
import { providerInitials } from "../../loop/providers";
import {
  answerAuthFlow,
  fetchLoopProviders,
  loginWithApiKey,
  logoutProvider,
  runAuthFlow,
  type AuthFlowEvent,
  type LoopProviderStatus,
} from "../../loop/providers/auth";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  buildProviderRows,
  connectionState,
  connectionSummary,
  filterProviderRows,
  primaryMethod,
  type ProviderRow,
} from "./LoopProviderSettings.logic";

/** Live state of a sign-in in progress, for the one row running it. */
interface FlowState {
  readonly provider: string;
  readonly method: LoopAuthMethod;
  /** Known once loop has accepted the start; prompts cannot be answered before. */
  readonly flowId: string | null;
  readonly events: readonly AuthFlowEvent[];
  /** Prompt ids already answered, so a resolved question stops asking. */
  readonly answered: ReadonlySet<string>;
}

function useLoopProviders() {
  const [snapshot, setSnapshot] = useState<{
    providers: readonly LoopProviderStatus[];
    active: string | null;
  }>({ providers: [], active: null });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await fetchLoopProviders());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach loop.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...snapshot, isLoading, error, refresh };
}

export function LoopProviderSettingsPanel() {
  const { providers, active, isLoading, error, refresh } = useLoopProviders();
  const [query, setQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The running flow's id, readable outside a state updater. */
  const flowIdRef = useRef<string | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const rows = useMemo(() => buildProviderRows({ providers, active }), [providers, active]);
  const visibleRows = useMemo(() => filterProviderRows(rows, query), [rows, query]);
  const connectedCount = rows.filter((row) => row.status.authorized).length;
  // Every provider reporting zero sign-in methods means the list was rebuilt
  // from `auth.status` — the fallback for a loop without `auth.providers`.
  // Saying so beats a page of rows whose Connect buttons are all missing.
  const isLegacyAgent = rows.length > 0 && rows.every((row) => row.methods.length === 0);

  const manualRefresh = useCallback(() => {
    setIsRefreshing(true);
    void refresh().finally(() => setIsRefreshing(false));
  }, [refresh]);

  /**
   * Run an OAuth / device / detect login.
   *
   * The flow is driven to completion here rather than fired and forgotten,
   * because half of these need the user mid-flight — Copilot asks for an
   * Enterprise domain before it can even request a device code — and a poll
   * that nobody drains would leave that question unanswered forever.
   */
  const startFlow = useCallback(
    (row: ProviderRow, method: LoopAuthMethod) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setExpanded(row.id);
      flowIdRef.current = null;
      setFlow({ provider: row.id, method, flowId: null, events: [], answered: new Set() });

      void runAuthFlow(
        {
          provider: row.id,
          method,
          signal: controller.signal,
          onStart: (flowId) => {
            flowIdRef.current = flowId;
            setFlow((current) =>
              current?.provider === row.id ? { ...current, flowId } : current,
            );
          },
        },
        (event) => {
          setFlow((current) =>
            current?.provider === row.id
              ? { ...current, events: [...current.events, event] }
              : current,
          );
          // Opening the browser is the one side effect the UI owns: loop runs
          // headless here and cannot know there is a window to open.
          if (event.type === "auth") window.open(event.url, "_blank", "noopener,noreferrer");
        },
      )
        .then(({ status }) => {
          if (status === "done") {
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: `Connected ${row.presentation.label}`,
                description: "loop can use this provider now, here and in the terminal.",
              }),
            );
            setFlow(null);
            setExpanded(null);
          }
          void refresh();
        })
        .catch((cause: unknown) => {
          setFlow((current) =>
            current?.provider === row.id
              ? {
                  ...current,
                  events: [
                    ...current.events,
                    {
                      type: "error",
                      message: cause instanceof Error ? cause.message : "The sign-in failed.",
                    },
                  ],
                }
              : current,
          );
        });
    },
    [refresh],
  );

  /**
   * Reply to a question a running flow is blocked on.
   *
   * The id comes from a ref rather than out of the state updater: an updater
   * has to stay pure (React may run it twice), so it is the wrong place to
   * read a value out of.
   */
  const answerPrompt = useCallback(async (promptId: string, value: string) => {
    const flowId = flowIdRef.current;
    if (flowId === null) return;
    setFlow((current) =>
      current ? { ...current, answered: new Set([...current.answered, promptId]) } : current,
    );
    await answerAuthFlow(flowId, promptId, value);
  }, []);

  const submitKey = useCallback(
    async (row: ProviderRow, apiKey: string) => {
      await loginWithApiKey(row.id, apiKey);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Connected ${row.presentation.label}`,
          description: "loop can use this provider now, here and in the terminal.",
        }),
      );
      setExpanded(null);
      await refresh();
    },
    [refresh],
  );

  const disconnect = useCallback(
    async (row: ProviderRow) => {
      await logoutProvider(row.id);
      setExpanded(null);
      await refresh();
    },
    [refresh],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="providers"
        title="Providers"
        headerAction={
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground/60">
              {isLoading
                ? "Loading"
                : `${connectedCount} of ${rows.length} connected`}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              disabled={isRefreshing}
              onClick={manualRefresh}
              aria-label="Refresh providers"
            >
              {isRefreshing ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
            </Button>
          </div>
        }
      >
        {error ? (
          <div className="mx-3 rounded-lg border border-destructive/32 bg-destructive/8 px-3 py-2 text-[13px] text-destructive-foreground sm:mx-4">
            {error}
          </div>
        ) : null}

        {isLegacyAgent ? (
          <div className="mx-3 rounded-lg border border-warning/32 bg-warning/8 px-3 py-2 text-[13px] leading-[1.45] text-warning-foreground sm:mx-4">
            The <code className="font-mono">loop</code> on this machine is older than this app and
            cannot describe its logins, so these are read-only. Update loop, or sign in with{" "}
            <code className="font-mono">loop login</code> in a terminal — it is the same credential
            store either way.
          </div>
        ) : null}

        <div className="px-3 pb-1 sm:px-4">
          <div className="flex h-8 items-center gap-2 rounded-lg border border-input bg-background px-2.5 sm:h-7">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
            <Input
              unstyled
              value={query}
              placeholder="Search providers"
              aria-label="Search providers"
              className="h-full flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>

        {!isLoading && visibleRows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[13px] text-muted-foreground sm:px-4">
            No provider matches “{query}”.
          </p>
        ) : null}

        {visibleRows.map((row) => (
          <ProviderCard
            key={row.id}
            row={row}
            isExpanded={expanded === row.id}
            flow={flow?.provider === row.id ? flow : null}
            onToggle={() => setExpanded((current) => (current === row.id ? null : row.id))}
            onStartFlow={(method) => startFlow(row, method)}
            onSubmitKey={(apiKey) => submitKey(row, apiKey)}
            onAnswerPrompt={answerPrompt}
            onDisconnect={() => disconnect(row)}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ProviderMark({ row }: { row: ProviderRow }) {
  const Icon = row.presentation.icon;
  return (
    <span
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg border",
        row.status.authorized
          ? "border-border bg-card text-foreground"
          : "border-border/60 bg-muted/32 text-muted-foreground",
      )}
    >
      {Icon ? (
        <Icon className="size-4.5" aria-hidden />
      ) : (
        <span className="text-[10px] font-semibold leading-none">
          {providerInitials(row.presentation.label)}
        </span>
      )}
      {row.status.authorized ? (
        <span
          className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-success"
          style={{ boxShadow: "0 0 0 2px var(--card)" }}
          aria-hidden
        />
      ) : null}
    </span>
  );
}

function ProviderCard(props: {
  readonly row: ProviderRow;
  readonly isExpanded: boolean;
  readonly flow: FlowState | null;
  readonly onToggle: () => void;
  readonly onStartFlow: (method: LoopAuthMethod) => void;
  readonly onSubmitKey: (apiKey: string) => Promise<void>;
  readonly onAnswerPrompt: (promptId: string, value: string) => Promise<void>;
  readonly onDisconnect: () => Promise<void>;
}) {
  const { row, isExpanded, flow } = props;
  const state = connectionState(row.status);
  const primary = primaryMethod(row);
  const canDisconnect = state.kind === "connected" || state.kind === "custom";

  return (
    <SettingsRow
      className={cn(isExpanded && "bg-muted/24")}
      title={
        <span className="inline-flex items-center gap-2">
          {row.presentation.label}
          {row.isActive ? (
            <Badge variant="success" size="sm">
              Active
            </Badge>
          ) : null}
          {state.kind === "environment" ? (
            <Badge variant="info" size="sm">
              env
            </Badge>
          ) : null}
          {row.status.kind === "extension" ? (
            <Badge variant="outline" size="sm">
              extension
            </Badge>
          ) : null}
        </span>
      }
      description={connectionSummary(row)}
      control={
        <div className="flex items-center gap-1.5">
          {row.status.authorized ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-success-foreground">
              <CheckIcon className="size-3" />
              Connected
            </span>
          ) : primary ? (
            <Button size="sm" variant="outline" onClick={props.onToggle}>
              Connect
            </Button>
          ) : null}
          {primary || canDisconnect ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              onClick={props.onToggle}
              aria-label={isExpanded ? "Hide provider details" : "Show provider details"}
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")}
              />
            </Button>
          ) : null}
        </div>
      }
    >
      {isExpanded ? (
        <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
          {flow ? (
            <AuthFlowTranscript flow={flow} onAnswer={props.onAnswerPrompt} />
          ) : (
            <ProviderLoginOptions
              row={row}
              onStartFlow={props.onStartFlow}
              onSubmitKey={props.onSubmitKey}
            />
          )}
          {canDisconnect && !flow ? (
            <div className="flex items-center justify-between gap-3 pt-1">
              <p className="text-xs text-muted-foreground/80">
                {state.kind === "custom"
                  ? "Removing this gateway deletes its endpoint and key from loop."
                  : "Removes the stored credential. loop keeps nothing else."}
              </p>
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() => void props.onDisconnect()}
              >
                {state.kind === "custom" ? "Remove" : "Disconnect"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsRow>
  );
}

function ProviderLoginOptions(props: {
  readonly row: ProviderRow;
  readonly onStartFlow: (method: LoopAuthMethod) => void;
  readonly onSubmitKey: (apiKey: string) => Promise<void>;
}) {
  const { row } = props;
  if (row.methods.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        loop reports no sign-in for this provider.
        {row.status.kind === "custom"
          ? " Custom gateways are configured with `loop login custom` in the terminal."
          : null}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {row.methods.map((method) =>
        method.method === "apikey" ? (
          <ApiKeyForm
            key={method.method}
            method={method}
            envVar={row.status.envVar}
            keysUrl={row.presentation.keysUrl}
            onSubmit={props.onSubmitKey}
          />
        ) : (
          <div
            key={method.method}
            className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="text-[13px] font-medium">{method.label}</p>
              {method.hint ? (
                <p className="text-xs leading-[1.45] text-muted-foreground/80">{method.hint}</p>
              ) : null}
            </div>
            <Button size="sm" onClick={() => props.onStartFlow(method.method)}>
              {method.method === "detect" ? "Check" : "Sign in"}
            </Button>
          </div>
        ),
      )}
    </div>
  );
}

function ApiKeyForm(props: {
  readonly method: LoopLoginMethod;
  readonly envVar: string | undefined;
  readonly keysUrl: string | undefined;
  readonly onSubmit: (apiKey: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = () => {
    const apiKey = value.trim();
    if (apiKey === "" || isSaving) return;
    setIsSaving(true);
    setFailure(null);
    void props
      .onSubmit(apiKey)
      .then(() => setValue(""))
      .catch((cause: unknown) =>
        setFailure(cause instanceof Error ? cause.message : "Could not save the key."),
      )
      .finally(() => setIsSaving(false));
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="inline-flex items-center gap-1.5 text-[13px] font-medium">
          <KeyRoundIcon className="size-3.5 text-muted-foreground" />
          {props.method.label}
        </p>
        {props.keysUrl ? (
          <a
            href={props.keysUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Get a key
            <ExternalLinkIcon className="size-3" />
          </a>
        ) : null}
      </div>
      {props.method.hint ? (
        <p className="text-xs leading-[1.45] text-muted-foreground/80">{props.method.hint}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          type="password"
          size="sm"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={props.method.placeholder ?? "Paste your key"}
          aria-label={props.method.label}
          className="flex-1 rounded-md border border-input bg-background"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <Button size="sm" disabled={value.trim() === "" || isSaving} onClick={submit}>
          {isSaving ? <LoaderIcon className="size-3 animate-spin" /> : "Save"}
        </Button>
      </div>
      {props.envVar ? (
        <p className="text-xs text-muted-foreground/70">
          loop also reads <code className="font-mono">${props.envVar}</code> when no key is stored.
        </p>
      ) : null}
      {failure ? <p className="text-xs text-destructive-foreground">{failure}</p> : null}
    </div>
  );
}

/**
 * The running sign-in, as loop narrates it.
 *
 * A browser-based login is opaque by nature — the user leaves, does something
 * elsewhere, and comes back — so echoing loop's own progress messages is the
 * only way the page can say anything true about what is happening.
 */
function AuthFlowTranscript({
  flow,
  onAnswer,
}: {
  readonly flow: FlowState;
  readonly onAnswer: (promptId: string, value: string) => Promise<void>;
}) {
  const prompt = [...flow.events]
    .reverse()
    .find(
      (event): event is Extract<AuthFlowEvent, { type: "prompt" }> =>
        event.type === "prompt" && !flow.answered.has(event.promptId),
    );
  const failed = flow.events.some((event) => event.type === "error");

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        {failed ? null : <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />}
        {failed ? "Sign-in failed" : "Signing in…"}
      </div>
      <ul className="space-y-1">
        {flow.events.map((event, index) => (
          <li
            key={index}
            className={cn(
              "text-xs leading-[1.5]",
              event.type === "error" ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {event.type === "auth" ? (
              <a
                href={event.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
              >
                {event.instructions ?? "Continue in your browser"}
                <ExternalLinkIcon className="size-3" />
              </a>
            ) : event.type === "prompt" ? (
              event.message
            ) : (
              event.message
            )}
          </li>
        ))}
      </ul>
      {prompt && flow.flowId !== null ? (
        <AuthFlowPrompt key={prompt.promptId} prompt={prompt} onAnswer={onAnswer} />
      ) : null}
    </div>
  );
}

/**
 * A question the sign-in is blocked on, and the field that unblocks it.
 *
 * Not decoration: `login()` on the core side awaits `onPrompt`, so a flow that
 * asks something and never hears back stays parked forever. Copilot's very
 * first act is to ask for a GitHub Enterprise domain, which is why this has to
 * exist for that provider to be connectable from the app at all. It is
 * skippable when loop marks the question optional — that is how you say
 * "plain github.com".
 */
function AuthFlowPrompt({
  prompt,
  onAnswer,
}: {
  readonly prompt: Extract<AuthFlowEvent, { type: "prompt" }>;
  readonly onAnswer: (promptId: string, value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [isSending, setIsSending] = useState(false);

  const send = (answer: string) => {
    if (isSending) return;
    setIsSending(true);
    void onAnswer(prompt.promptId, answer).finally(() => setIsSending(false));
  };

  return (
    <div className="space-y-2 rounded-md bg-muted/48 px-2.5 py-2">
      <p className="text-xs text-foreground">{prompt.message}</p>
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          autoFocus
          value={value}
          placeholder={prompt.placeholder ?? ""}
          aria-label={prompt.message}
          className="flex-1 rounded-md border border-input bg-background"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              send(value.trim());
            }
          }}
        />
        <Button
          size="sm"
          disabled={isSending || (value.trim() === "" && !prompt.allowEmpty)}
          onClick={() => send(value.trim())}
        >
          {isSending ? <LoaderIcon className="size-3 animate-spin" /> : "Send"}
        </Button>
        {prompt.allowEmpty ? (
          <Button size="sm" variant="ghost" disabled={isSending} onClick={() => send("")}>
            Skip
          </Button>
        ) : null}
      </div>
    </div>
  );
}
