import { ProviderDriverKind } from "@loop/contracts";
import { ClaudeAI, CursorIcon, GrokIcon, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { fromInstanceId } from "../../loop/handlers/ids";
import { providerPresentation } from "../../loop/providers";
export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
};

/**
 * The mark for a provider, wherever one is rendered.
 *
 * Two id spaces meet here. The map above is keyed by the upstream app's
 * *coding-agent* driver kinds; loop's providers arrive as encoded provider ids
 * instead (`anthropic`, `github-copilot`, `custom__pronto-gpt` — see
 * handlers/ids.ts). Only the second kind actually occurs in loop, but the
 * first is kept because a stored thread may still carry one.
 *
 * Falling through to the loop catalog is what puts a real brand mark on the
 * composer and model picker; without it every row rendered as a lettermark,
 * since no loop provider id can ever match a driver-kind key.
 */
export function providerIconFor(driverKind: ProviderDriverKind): Icon | null {
  return (
    PROVIDER_ICON_BY_PROVIDER[driverKind] ??
    providerPresentation(fromInstanceId(driverKind)).icon ??
    null
  );
}

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  isLegacy?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
