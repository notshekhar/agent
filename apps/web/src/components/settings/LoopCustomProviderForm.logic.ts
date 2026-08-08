/**
 * The add-a-gateway form's rules, kept out of the component so they are
 * testable without rendering — they are the part that decides whether a
 * gateway saves and routes, and every one of them mirrors a check the terminal
 * wizard makes (packages/cli/src/interactive/login-flow.ts `loginCustom`).
 */
import type {
  CustomProviderAuthInput,
  CustomProviderDraft,
  CustomProviderModel,
  CustomProviderSdk,
  CustomProviderSummary,
} from "../../loop/providers/custom";

/** The kinds the form offers, in the order `/login` offers them. */
export const AUTH_KINDS = ["apikey", "bearer", "oauth", "env", "helper", "none"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

export interface SdkOption {
  readonly value: CustomProviderSdk;
  readonly label: string;
  readonly description: string;
}

export const SDK_OPTIONS: readonly SdkOption[] = [
  {
    value: "anthropic",
    label: "Anthropic-compatible",
    description: "Claude API shape (/v1/messages)",
  },
  {
    value: "openai",
    label: "OpenAI-compatible",
    description: "Chat completions shape (/v1/chat/completions)",
  },
  { value: "google", label: "Google-compatible", description: "Gemini API shape (/v1beta)" },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible (generic)",
    description: "Proxies that speak the OpenAI shape but are not OpenAI",
  },
];

export interface AuthKindOption {
  readonly value: AuthKind;
  readonly label: string;
  readonly description: string;
}

export const AUTH_KIND_OPTIONS: readonly AuthKindOption[] = [
  {
    value: "apikey",
    label: "API key",
    description: "Stored key, sent in the vendor header (x-api-key / Bearer / x-goog-api-key)",
  },
  {
    value: "bearer",
    label: "Bearer token",
    description: "Always sent as Authorization: Bearer — gateways with their own tokens",
  },
  {
    value: "oauth",
    label: "OAuth / SSO",
    description: "Browser sign-in; endpoints discovered from the base URL, tokens auto-refresh",
  },
  {
    value: "env",
    label: "Environment variable",
    description: "Key read from an env var at request time — nothing stored on disk",
  },
  {
    value: "helper",
    label: "Command (key helper)",
    description: "Shell command whose output is the key — re-run every 5m and on 401",
  },
  {
    value: "none",
    label: "No credential",
    description: "Open endpoints, mTLS, or a key you send as a custom header below",
  },
];

/** Everything the form holds, as strings — one shape for both add and edit. */
export interface CustomProviderFormState {
  readonly name: string;
  readonly sdk: CustomProviderSdk;
  readonly baseURL: string;
  readonly authKind: AuthKind;
  /** The typed secret for `apikey` / `bearer`. Empty means "keep the stored one". */
  readonly secret: string;
  readonly envVar: string;
  readonly helperCommand: string;
  readonly oauthIssuer: string;
  readonly oauthClientId: string;
  readonly oauthScopes: string;
  /** Free text, one `Name: value` per line — see `parseHeaders`. */
  readonly headers: string;
  /** Model ids, comma or newline separated — see `parseModelIds`. */
  readonly modelIds: string;
  /** Discovered models, kept whole so names and context windows survive. */
  readonly discovered: readonly CustomProviderModel[];
}

export const EMPTY_FORM: CustomProviderFormState = {
  name: "",
  sdk: "anthropic",
  baseURL: "",
  authKind: "apikey",
  secret: "",
  envVar: "",
  helperCommand: "",
  oauthIssuer: "",
  oauthClientId: "",
  oauthScopes: "",
  headers: "",
  modelIds: "",
  discovered: [],
};

/** Serialize headers back into the textarea's format. */
export function formatHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/** The form prefilled from a saved gateway, ready to edit. */
export function formStateFrom(summary: CustomProviderSummary): CustomProviderFormState {
  return {
    ...EMPTY_FORM,
    name: summary.name,
    sdk: summary.sdk,
    baseURL: summary.baseURL,
    authKind: summary.authKind,
    envVar: summary.envVar ?? "",
    helperCommand: summary.helperCommand ?? "",
    headers: formatHeaders(summary.headers),
    modelIds: summary.models.map((model) => model.id).join("\n"),
    discovered: summary.models,
  };
}

/**
 * Headers as `Name: value`, one per line.
 *
 * The terminal takes them semicolon-separated on a single prompt line; a
 * textarea can afford a line each, so both separators are accepted and a value
 * containing a colon (a URL, a base64 token) survives, because only the FIRST
 * colon splits.
 */
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/[\n;]/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (name !== "") headers[name] = value;
  }
  return headers;
}

/** Model ids from a comma- or newline-separated field, de-duplicated in order. */
export function parseModelIds(raw: string): readonly string[] {
  const seen = new Set<string>();
  for (const token of raw.split(/[\n,]/)) {
    const id = token.trim();
    if (id !== "") seen.add(id);
  }
  return [...seen];
}

/**
 * The models a save would write.
 *
 * Discovery returns names and context windows the endpoint reported; the id
 * field is what the user actually chose to keep. Intersecting them preserves
 * the metadata for every id that came from discovery while still letting the
 * user add or remove ids by hand — losing the metadata would silently reset
 * every discovered model to core's 200k/16k defaults.
 */
export function resolveModels(state: CustomProviderFormState): readonly CustomProviderModel[] {
  const byId = new Map(state.discovered.map((model) => [model.id, model]));
  return parseModelIds(state.modelIds).map((id) => byId.get(id) ?? { id });
}

/** The auth block a save would send, or `keep` when a secret was left blank. */
export function resolveAuth(
  state: CustomProviderFormState,
  hasStoredSecret: boolean,
): CustomProviderAuthInput {
  switch (state.authKind) {
    case "apikey":
      // An edit form is never shown the stored key, so an untouched field must
      // mean "leave it alone" — anything else silently wipes the credential.
      return state.secret.trim() === "" && hasStoredSecret
        ? { kind: "keep" }
        : { kind: "apikey", apiKey: state.secret.trim() };
    case "bearer":
      return state.secret.trim() === "" && hasStoredSecret
        ? { kind: "keep" }
        : { kind: "bearer", token: state.secret.trim() };
    case "env":
      return { kind: "env", var: state.envVar.trim() };
    case "helper":
      return { kind: "helper", command: state.helperCommand.trim() };
    case "oauth": {
      const scopes = state.oauthScopes
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter((scope) => scope !== "");
      const options = {
        ...(state.oauthIssuer.trim() === "" ? {} : { issuer: state.oauthIssuer.trim() }),
        ...(state.oauthClientId.trim() === "" ? {} : { clientId: state.oauthClientId.trim() }),
        ...(scopes.length === 0 ? {} : { scopes }),
      };
      return Object.keys(options).length === 0 ? { kind: "oauth" } : { kind: "oauth", oauth: options };
    }
    default:
      return { kind: "none" };
  }
}

/** The draft as loop takes it. Models are omitted while only probing. */
export function buildDraft(
  state: CustomProviderFormState,
  options: { readonly hasStoredSecret: boolean; readonly withModels: boolean },
): CustomProviderDraft {
  const headers = parseHeaders(state.headers);
  const models = options.withModels ? resolveModels(state) : undefined;
  return {
    name: state.name.trim().toLowerCase(),
    sdk: state.sdk,
    baseURL: state.baseURL.trim(),
    auth: resolveAuth(state, options.hasStoredSecret),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(models === undefined ? {} : { models }),
  };
}

const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * What is still missing, in the order the form reads.
 *
 * `stage: "probe"` is the subset discovery needs — an endpoint can be probed
 * before any model is chosen, and refusing to probe until models exist would
 * be circular, since probing is how they get there.
 */
export function validateForm(
  state: CustomProviderFormState,
  options: {
    readonly hasStoredSecret: boolean;
    readonly existingNames: ReadonlySet<string>;
    readonly stage: "probe" | "save";
  },
): string | null {
  const name = state.name.trim().toLowerCase();
  if (name === "") return "Name is required.";
  if (!NAME_PATTERN.test(name)) return "Name must be lowercase letters, digits, and hyphens.";
  if (options.existingNames.has(name)) return `A gateway named “${name}” already exists.`;
  if (state.baseURL.trim() === "") return "Base URL is required.";
  if (!/^https?:\/\//i.test(state.baseURL.trim())) return "Base URL must start with http:// or https://.";

  const auth = resolveAuth(state, options.hasStoredSecret);
  if (auth.kind === "apikey" && auth.apiKey === "") return "API key is required.";
  if (auth.kind === "bearer" && auth.token === "") return "Bearer token is required.";
  if (auth.kind === "env" && auth.var === "") return "Environment variable name is required.";
  if (auth.kind === "helper" && auth.command === "") return "Helper command is required.";

  if (options.stage === "save" && resolveModels(state).length === 0) {
    return "Add at least one model id — discover them, or type them in.";
  }
  return null;
}
