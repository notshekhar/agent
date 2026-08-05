/**
 * Translating loop's provider ids into the ids the contract will accept.
 *
 * MEASURED, and it contradicts the obvious assumption: `ProviderInstanceId` is
 * a slug matching `^[a-zA-Z][a-zA-Z0-9_-]*$`, so it does **not** accept `:` —
 * and loop's real provider ids include `custom:pronto-gpt`. Worse, the failure
 * is silent: `ServerProviders` is a `ForwardCompatibleArray`, so a provider
 * whose id fails to decode is dropped from the list rather than reported.
 *
 * So every loop provider id crosses this boundary through `toInstanceId`, and
 * comes back through `fromInstanceId` before it is handed to loop again. The
 * pair must round-trip: an id that goes out and comes back has to route to the
 * same provider, or a thread would silently switch models.
 *
 * Sessions in the wild also carry provider ids loop itself no longer has —
 * including the empty string — so an unusable id maps to a single reserved
 * slug rather than throwing.
 */

/** Stands in for a provider id that cannot be represented, e.g. `""`. */
export const UNKNOWN_PROVIDER_INSTANCE_ID = "unknown";

/**
 * `:` is the only illegal character loop actually uses, and `__` is legal in a
 * slug. loop's own ids are kebab-case and never contain `__`, which is what
 * keeps the encoding injective.
 */
const COLON_ESCAPE = "__";

export function toInstanceId(loopProviderId: string): string {
  const trimmed = loopProviderId.trim();
  if (trimmed === "") return UNKNOWN_PROVIDER_INSTANCE_ID;
  const encoded = trimmed.replaceAll(":", COLON_ESCAPE);
  // A slug must start with a letter; anything else is not representable.
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(encoded) ? encoded : UNKNOWN_PROVIDER_INSTANCE_ID;
}

export function fromInstanceId(instanceId: string): string {
  return instanceId === UNKNOWN_PROVIDER_INSTANCE_ID
    ? ""
    : instanceId.replaceAll(COLON_ESCAPE, ":");
}
