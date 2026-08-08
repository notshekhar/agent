/**
 * What the Providers page shows, derived from what loop reports.
 *
 * Kept apart from the component so the ordering and status rules are testable
 * without rendering: they are the part that decides whether the page reads as
 * "you have three providers connected" or as an undifferentiated wall.
 */
import {
  loginMethodsFor,
  providerPresentation,
  type LoopAuthMethod,
  type LoopLoginMethod,
  type LoopProviderPresentation,
} from "../../loop/providers";
import type { LoopProviderStatus } from "../../loop/providers/auth";

export interface ProviderRow {
  readonly id: string;
  readonly presentation: LoopProviderPresentation;
  readonly status: LoopProviderStatus;
  /** The logins to offer, already intersected with what loop supports. */
  readonly methods: readonly LoopLoginMethod[];
  /** Number of catalog models loop can currently reach through this provider. */
  readonly modelCount: number;
  readonly isActive: boolean;
}

export type ProviderConnectionState =
  /** Credentials stored by loop — disconnecting is possible. */
  | { readonly kind: "connected"; readonly via: "oauth" | "apikey" }
  /** Authorized, but the credential came from the environment, not the store. */
  | { readonly kind: "environment"; readonly envVar: string }
  /** A gateway the user configured; loop holds its endpoint and key. */
  | { readonly kind: "custom"; readonly baseURL: string | undefined }
  | { readonly kind: "disconnected" };

/**
 * How a provider is connected — which is not the same question as whether it
 * is authorized.
 *
 * A key in `$ANTHROPIC_API_KEY` authorizes the provider just as a stored one
 * does, but there is nothing for a Disconnect button to remove: loop would
 * delete an entry that was never written and the provider would stay
 * connected. Distinguishing the two is what keeps that button honest.
 */
export function connectionState(status: LoopProviderStatus): ProviderConnectionState {
  if (status.kind === "custom") {
    return { kind: "custom", baseURL: status.baseURL };
  }
  if (status.mode === "oauth") return { kind: "connected", via: "oauth" };
  if (status.mode === "apikey") return { kind: "connected", via: "apikey" };
  if (status.authorized && status.envVar) {
    return { kind: "environment", envVar: status.envVar };
  }
  return { kind: "disconnected" };
}

/** One line under the provider name saying where it stands. */
export function connectionSummary(row: ProviderRow): string {
  const state = connectionState(row.status);
  switch (state.kind) {
    case "connected": {
      const via = state.via === "oauth" ? "Signed in" : "API key";
      return row.modelCount > 0
        ? `${via} · ${row.modelCount} model${row.modelCount === 1 ? "" : "s"}`
        : via;
    }
    case "environment":
      return `Key from $${state.envVar}`;
    case "custom":
      return state.baseURL ?? "Custom gateway";
    default:
      return row.presentation.tagline ?? "Not connected";
  }
}

/** The dot beside a provider, matching the language the rest of settings uses. */
export function statusTone(status: LoopProviderStatus): "ready" | "idle" {
  return status.authorized ? "ready" : "idle";
}

/**
 * Rows for the page: connected providers first, then the rest alphabetically.
 *
 * Connected-first is the whole ordering rule and it is deliberate. The list is
 * ~18 long and all but a couple of rows are things the user will never touch;
 * burying the two that are live in alphabetical position makes the page look
 * like a catalog rather than a status board.
 */
export function buildProviderRows(input: {
  readonly providers: readonly LoopProviderStatus[];
  readonly active: string | null;
  /** Model counts per loop provider id, from the catalog. */
  readonly modelCounts?: ReadonlyMap<string, number>;
}): readonly ProviderRow[] {
  const rows = input.providers.map((status): ProviderRow => {
    const presentation = providerPresentation(status.id);
    return {
      id: status.id,
      presentation,
      status,
      methods: loginMethodsFor(status.id, status.methods),
      modelCount: input.modelCounts?.get(status.id) ?? 0,
      isActive: input.active === status.id,
    };
  });

  return rows.toSorted((left, right) => {
    if (left.status.authorized !== right.status.authorized) {
      return left.status.authorized ? -1 : 1;
    }
    return left.presentation.label.localeCompare(right.presentation.label);
  });
}

/** Which login a row's primary button should run, or null when there is none. */
export function primaryMethod(row: ProviderRow): LoopLoginMethod | null {
  // Preference order, and it matters: a provider offering both OAuth and a key
  // should lead with OAuth, because that is the path that needs no secret
  // pasted into a text field.
  const order: readonly LoopAuthMethod[] = ["oauth", "detect", "apikey"];
  for (const method of order) {
    const found = row.methods.find((candidate) => candidate.method === method);
    if (found) return found;
  }
  return null;
}

/** Rows matching a query over id, label, and tagline. Empty query keeps all. */
export function filterProviderRows(
  rows: readonly ProviderRow[],
  query: string,
): readonly ProviderRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter((row) =>
    [row.id, row.presentation.label, row.presentation.tagline ?? ""].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}
