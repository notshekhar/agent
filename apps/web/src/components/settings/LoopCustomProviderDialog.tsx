/**
 * Adding — or editing — a custom gateway, without leaving the app.
 *
 * This is the terminal's `loop login` → "custom" wizard as one form. It is
 * deliberately not a multi-step wizard: every field except the model list is
 * answerable up front, and the one step that genuinely depends on the others
 * (discovery, which needs the URL and the credential) is a button rather than a
 * page, so a wrong key can be fixed in place instead of by walking back.
 *
 * The order of operations matters and mirrors core's: an OAuth gateway signs in
 * BEFORE anything is saved, because discovery needs the token the sign-in
 * produces — see `runCustomOAuth` in packages/core/src/rpc/auth-flows.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLinkIcon, LoaderIcon, SearchIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { answerAuthFlow, runAuthFlow, type AuthFlowEvent } from "../../loop/providers/auth";
import {
  discoverCustomProviderModels,
  saveCustomProvider,
  type CustomProviderSdk,
  type CustomProviderSummary,
} from "../../loop/providers/custom";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AUTH_KIND_OPTIONS,
  EMPTY_FORM,
  SDK_OPTIONS,
  buildDraft,
  formStateFrom,
  resolveModels,
  validateForm,
  type AuthKind,
  type CustomProviderFormState,
} from "./LoopCustomProviderForm.logic";

interface LoopCustomProviderDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The gateway being edited, or undefined when adding a new one. */
  readonly editing?: CustomProviderSummary | undefined;
  /** Names already taken, so a new gateway cannot silently overwrite one. */
  readonly existingNames: ReadonlySet<string>;
  readonly onSaved: () => void;
}

type Busy = "idle" | "discovering" | "signing-in" | "saving";

export function LoopCustomProviderDialog(props: LoopCustomProviderDialogProps) {
  const { editing } = props;
  const [form, setForm] = useState<CustomProviderFormState>(EMPTY_FORM);
  const [busy, setBusy] = useState<Busy>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [flowEvents, setFlowEvents] = useState<readonly AuthFlowEvent[]>([]);
  /** Prompt ids already answered, so a resolved question stops asking. */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [signedIn, setSignedIn] = useState(false);
  const flowIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset on every open so a cancelled add does not bleed into the next one,
  // and an edit always starts from what is actually stored.
  useEffect(() => {
    if (!props.open) return;
    setForm(editing ? formStateFrom(editing) : EMPTY_FORM);
    setBusy("idle");
    setFailure(null);
    setNotice(null);
    setFlowEvents([]);
    setAnswered(new Set());
    setSignedIn(editing?.hasOAuthSession ?? false);
  }, [props.open, editing]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const hasStoredSecret = editing?.hasStoredSecret ?? false;
  // Editing a gateway means its own name is not a collision.
  const takenNames = useMemo(() => {
    if (!editing) return props.existingNames;
    const names = new Set(props.existingNames);
    names.delete(editing.name);
    return names;
  }, [editing, props.existingNames]);

  const patch = useCallback(
    (changes: Partial<CustomProviderFormState>) => setForm((current) => ({ ...current, ...changes })),
    [],
  );

  const modelCount = resolveModels(form).length;
  const needsSignIn = form.authKind === "oauth" && !signedIn;

  const discover = useCallback(async () => {
    const invalid = validateForm(form, { hasStoredSecret, existingNames: takenNames, stage: "probe" });
    if (invalid) {
      setFailure(invalid);
      return;
    }
    setBusy("discovering");
    setFailure(null);
    setNotice(null);
    try {
      const models = await discoverCustomProviderModels(
        buildDraft(form, { hasStoredSecret, withModels: false }),
      );
      if (models === null) {
        // Not a failure: plenty of gateways expose no /models route, and the
        // answer is to type the ids in — exactly what the terminal falls back to.
        setNotice("This endpoint does not list its models. Enter the model ids below.");
        return;
      }
      setForm((current) => ({
        ...current,
        discovered: models,
        modelIds: models.map((model) => model.id).join("\n"),
      }));
      setNotice(`Found ${models.length} model${models.length === 1 ? "" : "s"}.`);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Could not reach the endpoint.");
    } finally {
      setBusy("idle");
    }
  }, [form, hasStoredSecret, takenNames]);

  /**
   * Sign in to an OAuth gateway from the draft, before it is saved.
   *
   * The session lands under the gateway's name, so `auth.custom.save` writes
   * the config around a login that already exists — and discovery in between
   * can use the token.
   */
  const signIn = useCallback(async () => {
    const invalid = validateForm(form, { hasStoredSecret, existingNames: takenNames, stage: "probe" });
    if (invalid) {
      setFailure(invalid);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("signing-in");
    setFailure(null);
    setFlowEvents([]);
    setAnswered(new Set());
    try {
      const { status } = await runAuthFlow(
        {
          provider: `custom:${form.name.trim().toLowerCase()}`,
          method: "oauth",
          signal: controller.signal,
          custom: buildDraft(form, { hasStoredSecret, withModels: false }),
          onStart: (flowId) => {
            flowIdRef.current = flowId;
          },
        },
        (event) => {
          setFlowEvents((current) => [...current, event]);
          // loop runs headless here and cannot know there is a window to open.
          if (event.type === "auth") window.open(event.url, "_blank", "noopener,noreferrer");
        },
      );
      if (status === "done") {
        setSignedIn(true);
        setNotice("Signed in. Discover this gateway's models next.");
      }
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "The sign-in failed.");
    } finally {
      setBusy("idle");
    }
  }, [form, hasStoredSecret, takenNames]);

  const answerPrompt = useCallback(async (promptId: string, value: string) => {
    const flowId = flowIdRef.current;
    if (flowId === null) return;
    setAnswered((current) => new Set([...current, promptId]));
    await answerAuthFlow(flowId, promptId, value);
  }, []);

  const save = useCallback(async () => {
    const invalid = validateForm(form, { hasStoredSecret, existingNames: takenNames, stage: "save" });
    if (invalid) {
      setFailure(invalid);
      return;
    }
    setBusy("saving");
    setFailure(null);
    try {
      const result = await saveCustomProvider(buildDraft(form, { hasStoredSecret, withModels: true }));
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `${editing ? "Updated" : "Added"} ${result.name}`,
          description: `${result.models} model${result.models === 1 ? "" : "s"} — usable here and in the terminal.`,
        }),
      );
      props.onSaved();
      props.onOpenChange(false);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Could not save the gateway.");
    } finally {
      setBusy("idle");
    }
  }, [editing, form, hasStoredSecret, props, takenNames]);

  const pendingPrompt = [...flowEvents]
    .reverse()
    .find(
      (event): event is Extract<AuthFlowEvent, { type: "prompt" }> =>
        event.type === "prompt" && !answered.has(event.promptId),
    );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "Add a custom provider"}</DialogTitle>
          <DialogDescription>
            Any compatible endpoint — bifrost, LiteLLM, a proxy, a self-hosted model server. loop
            stores it once: the terminal sees it too.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-6 pb-2">
          <Field label="Name" hint="Lowercase letters, digits, hyphens. Becomes `custom:<name>`.">
            <Input
              size="sm"
              autoFocus={!editing}
              disabled={Boolean(editing)}
              value={form.name}
              placeholder="bifrost"
              className="rounded-md border border-input bg-background"
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>

          <Field label="API shape" hint="Which vendor API the endpoint speaks.">
            <Select
              value={form.sdk}
              onValueChange={(value) => patch({ sdk: value as CustomProviderSdk })}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {SDK_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex flex-col items-start">
                      <span>{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <Field label="Base URL" hint="Where the endpoint lives, without the /v1 suffix loop adds.">
            <Input
              size="sm"
              value={form.baseURL}
              placeholder="http://bifrost.internal/anthropic"
              className="rounded-md border border-input bg-background"
              onChange={(event) => patch({ baseURL: event.target.value })}
            />
          </Field>

          <Field label="Authentication">
            <Select
              value={form.authKind}
              onValueChange={(value) => patch({ authKind: value as AuthKind, secret: "" })}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {AUTH_KIND_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex flex-col items-start">
                      <span>{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          {form.authKind === "apikey" || form.authKind === "bearer" ? (
            <Field
              label={form.authKind === "apikey" ? "API key" : "Bearer token"}
              hint={
                hasStoredSecret
                  ? "Leave blank to keep the credential already stored."
                  : "Stored by loop; never shown again."
              }
            >
              <Input
                type="password"
                size="sm"
                autoComplete="off"
                spellCheck={false}
                value={form.secret}
                placeholder={hasStoredSecret ? "•••••••• (unchanged)" : "Paste the credential"}
                className="rounded-md border border-input bg-background"
                onChange={(event) => patch({ secret: event.target.value })}
              />
            </Field>
          ) : null}

          {form.authKind === "env" ? (
            <Field label="Environment variable" hint="Read at request time — nothing is stored.">
              <Input
                size="sm"
                value={form.envVar}
                placeholder="BIFROST_API_KEY"
                className="rounded-md border border-input bg-background font-mono"
                onChange={(event) => patch({ envVar: event.target.value })}
              />
            </Field>
          ) : null}

          {form.authKind === "helper" ? (
            <Field
              label="Key helper command"
              hint="Its stdout is the key. Re-run every 5 minutes and after a 401."
            >
              <Input
                size="sm"
                value={form.helperCommand}
                placeholder="vault read -field=token secret/llm"
                className="rounded-md border border-input bg-background font-mono"
                onChange={(event) => patch({ helperCommand: event.target.value })}
              />
            </Field>
          ) : null}

          {form.authKind === "oauth" ? (
            <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
              <p className="text-xs leading-[1.45] text-muted-foreground/80">
                Endpoints are discovered from the base URL and the client registers itself. Fill
                these in only if your server does not support discovery.
              </p>
              <Field label="Issuer" optional>
                <Input
                  size="sm"
                  value={form.oauthIssuer}
                  placeholder="https://sso.internal"
                  className="rounded-md border border-input bg-background"
                  onChange={(event) => patch({ oauthIssuer: event.target.value })}
                />
              </Field>
              <Field label="Client ID" optional>
                <Input
                  size="sm"
                  value={form.oauthClientId}
                  className="rounded-md border border-input bg-background"
                  onChange={(event) => patch({ oauthClientId: event.target.value })}
                />
              </Field>
              <Field
                label="Scopes"
                optional
                hint="Space separated. Include offline_access when refresh tokens are gated behind it."
              >
                <Input
                  size="sm"
                  value={form.oauthScopes}
                  placeholder="openid profile offline_access"
                  className="rounded-md border border-input bg-background"
                  onChange={(event) => patch({ oauthScopes: event.target.value })}
                />
              </Field>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {signedIn ? "Signed in — tokens refresh automatically." : "Sign in before discovering models."}
                </p>
                <Button size="sm" disabled={busy !== "idle"} onClick={() => void signIn()}>
                  {busy === "signing-in" ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : signedIn ? (
                    "Sign in again"
                  ) : (
                    "Sign in"
                  )}
                </Button>
              </div>
              {flowEvents.length > 0 ? (
                <FlowTranscript
                  events={flowEvents}
                  prompt={pendingPrompt}
                  onAnswer={answerPrompt}
                />
              ) : null}
            </div>
          ) : null}

          <Field
            label="Extra headers"
            optional
            hint="One per line, as `Name: value`. Sent on every request."
          >
            <Textarea
              size="sm"
              spellCheck={false}
              value={form.headers}
              placeholder={"X-Virtual-Key: sk-...\nX-Tenant: research"}
              className="font-mono text-xs"
              onChange={(event) => patch({ headers: event.target.value })}
            />
          </Field>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium">
                Models
                {modelCount > 0 ? (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {modelCount} selected
                  </span>
                ) : null}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== "idle" || needsSignIn}
                onClick={() => void discover()}
              >
                {busy === "discovering" ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <>
                    <SearchIcon className="size-3" />
                    Discover
                  </>
                )}
              </Button>
            </div>
            <Textarea
              size="sm"
              spellCheck={false}
              value={form.modelIds}
              placeholder={"claude-opus-5\nclaude-sonnet-5"}
              className="font-mono text-xs"
              onChange={(event) => patch({ modelIds: event.target.value })}
            />
            <p className="text-xs text-muted-foreground/70">
              One id per line. Discovery fills this in when the endpoint lists its models; edit it
              to expose only the ones you want.
            </p>
          </div>

          {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
          {failure ? <p className="text-xs text-destructive-foreground">{failure}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={busy === "saving"} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy !== "idle"} onClick={() => void save()}>
            {busy === "saving" ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : editing ? (
              "Save changes"
            ) : (
              "Add provider"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field(props: {
  readonly label: string;
  readonly hint?: string;
  readonly optional?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline gap-1.5 text-[13px] font-medium">
        {props.label}
        {props.optional ? (
          <span className="text-xs font-normal text-muted-foreground/60">optional</span>
        ) : null}
      </span>
      {props.children}
      {props.hint ? (
        <span className="block text-xs leading-[1.45] text-muted-foreground/70">{props.hint}</span>
      ) : null}
    </label>
  );
}

/** loop's own narration of a running sign-in, plus whatever it is blocked on. */
function FlowTranscript(props: {
  readonly events: readonly AuthFlowEvent[];
  readonly prompt: Extract<AuthFlowEvent, { type: "prompt" }> | undefined;
  readonly onAnswer: (promptId: string, value: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const failed = props.events.some((event) => event.type === "error");

  return (
    <div className="space-y-2 rounded-md bg-muted/48 px-2.5 py-2">
      <ul className="space-y-1">
        {props.events.map((event, index) => (
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
            ) : (
              event.message
            )}
          </li>
        ))}
      </ul>
      {props.prompt && !failed ? (
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            autoFocus
            value={answer}
            placeholder={props.prompt.placeholder ?? ""}
            aria-label={props.prompt.message}
            className="flex-1 rounded-md border border-input bg-background"
            onChange={(event) => setAnswer(event.target.value)}
          />
          <Button
            size="sm"
            onClick={() => {
              const value = answer.trim();
              setAnswer("");
              void props.onAnswer(props.prompt!.promptId, value);
            }}
          >
            Send
          </Button>
        </div>
      ) : null}
    </div>
  );
}
