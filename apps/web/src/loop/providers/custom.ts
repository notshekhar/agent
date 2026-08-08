/**
 * Custom gateways, from the UI.
 *
 * A built-in provider already exists and a login just gives it a credential —
 * which is all `auth.login` ever did, and why the Providers page could connect
 * anthropic but only *describe* how to add a bifrost. A custom provider has no
 * prior existence: it IS its config (which API shape it speaks, where it lives,
 * how it authenticates, what it serves), so creating one is a different act
 * with a different RPC. See packages/core/src/rpc/custom-providers.ts.
 *
 * Model discovery is a separate call from saving, deliberately: the endpoint is
 * probed with the credential the user just typed, before anything is written,
 * so a wrong key or a wrong base URL is caught while the form is still open
 * rather than becoming a saved gateway with an empty picker.
 */
import { loopCall } from "../transport.ts";

/** The vendor API shapes loop can speak to. Mirrors core's `CustomProviderSdk`. */
export type CustomProviderSdk = "anthropic" | "openai" | "google" | "openai-compatible";

/**
 * How a gateway authenticates, as the form describes it.
 *
 * `keep` is a UI-only kind that core understands on the way in: it means "the
 * user did not retype the secret, reuse what is stored". An edit form needs it
 * because the stored secret is deliberately never sent back down.
 */
export type CustomProviderAuthInput =
  | { readonly kind: "apikey"; readonly apiKey: string }
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "env"; readonly var: string }
  | { readonly kind: "helper"; readonly command: string; readonly ttlMs?: number }
  | { readonly kind: "oauth"; readonly oauth?: CustomOAuthOptions }
  | { readonly kind: "none" }
  | { readonly kind: "keep" };

export interface CustomOAuthOptions {
  readonly issuer?: string;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes?: readonly string[];
}

export interface CustomProviderModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
}

/** A gateway as it is sent to loop — not yet saved. */
export interface CustomProviderDraft {
  readonly name: string;
  readonly sdk: CustomProviderSdk;
  readonly baseURL: string;
  readonly auth: CustomProviderAuthInput;
  readonly headers?: Record<string, string>;
  readonly models?: readonly CustomProviderModel[];
}

/** A saved gateway, with its credential withheld. */
export interface CustomProviderSummary {
  readonly id: string;
  readonly name: string;
  readonly sdk: CustomProviderSdk;
  readonly baseURL: string;
  readonly authKind: Exclude<CustomProviderAuthInput["kind"], "keep">;
  readonly authDescription: string;
  readonly hasStoredSecret: boolean;
  readonly envVar?: string;
  readonly helperCommand?: string;
  readonly hasOAuthSession: boolean;
  readonly headers?: Record<string, string>;
  readonly models: readonly CustomProviderModel[];
}

/** Every gateway loop has configured. */
export async function fetchCustomProviders(cwd?: string): Promise<readonly CustomProviderSummary[]> {
  const result = await loopCall<{ providers?: readonly CustomProviderSummary[] }>(
    "auth.custom.list",
    {},
    cwd,
  );
  return result.providers ?? [];
}

/**
 * Ask a draft endpoint what it serves.
 *
 * `null` is a real answer, not a failure: plenty of gateways expose no
 * `/models` route at all, and the form's response to that is to ask for ids by
 * hand — the same thing the terminal wizard does. Only an unreachable loop
 * throws.
 */
export async function discoverCustomProviderModels(
  draft: CustomProviderDraft,
  cwd?: string,
): Promise<readonly CustomProviderModel[] | null> {
  const result = await loopCall<{ models?: readonly CustomProviderModel[] | null }>(
    "auth.custom.discover",
    draft as unknown as Record<string, unknown>,
    cwd,
  );
  return result.models ?? null;
}

/** Persist a gateway. Saving an existing name edits it in place. */
export async function saveCustomProvider(
  draft: CustomProviderDraft,
  cwd?: string,
): Promise<{ id: string; name: string; models: number }> {
  return await loopCall<{ id: string; name: string; models: number }>(
    "auth.custom.save",
    draft as unknown as Record<string, unknown>,
    cwd,
  );
}

/** Delete a gateway, its stored credential, and any OAuth session. */
export async function removeCustomProvider(name: string, cwd?: string): Promise<void> {
  await loopCall("auth.custom.remove", { name }, cwd);
}

/** Make a gateway the provider new sessions start on. */
export async function setActiveCustomProvider(name: string, cwd?: string): Promise<void> {
  await loopCall("auth.custom.setActive", { name }, cwd);
}

/**
 * Whether the loop on this machine can create a gateway at all.
 *
 * The desktop shell spawns whichever `loop` is installed, so it can trail the
 * app by a release. Asking `server.info` for the method beats discovering the
 * gap by way of a "method not found" after the user has filled in a form.
 */
export async function supportsCustomProviderRpc(cwd?: string): Promise<boolean> {
  try {
    const info = await loopCall<{ methods?: readonly string[] }>("server.info", {}, cwd);
    return (info.methods ?? []).includes("auth.custom.save");
  } catch {
    return false;
  }
}
