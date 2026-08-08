import { type CSSProperties, memo } from "react";
import { type ProviderDriverKind } from "@loop/contracts";

import { providerIconFor } from "./providerIconUtils";
import { fromInstanceId } from "../../loop/handlers/ids";
import { customProviderName } from "../../loop/providers";
import { cn } from "~/lib/utils";

export function providerInstanceInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
}) {
  const Icon = providerIconFor(props.driverKind);
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";
  /**
   * A gateway's mark is the mark of the API it speaks, so two gateways in
   * front of the same vendor draw identically — `custom:pronto-claude` and a
   * second Anthropic-compatible proxy would be one indistinguishable pair in
   * the picker. The initials badge is what tells them apart, so it is on by
   * default here rather than left to each of the five call sites to remember.
   */
  const gatewayName = customProviderName(fromInstanceId(props.driverKind));
  // OR, not a default: a caller passing `showBadge={false}` is answering the
  // *duplicate-driver* question ("is there more than one Codex?"), which is a
  // different question from "does this mark belong to something else?". For a
  // gateway the badge is the only identity it has, so it is never optional.
  const showBadge = (props.showBadge ?? false) || gatewayName !== null;
  const badgeLabel = gatewayName ?? props.displayName;

  return (
    <span
      className={cn(
        "relative isolate inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-[10px] font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-[8px] font-semibold leading-none shadow-sm",
            // A gateway's badge sits slightly OUTSIDE the bottom-right corner
            // rather than inside it: the mark it overlaps is borrowed, and
            // tucking the initials within the icon's own box reads as part of
            // the vendor's logo. The status dot lives at top-left, so this
            // corner is free.
            gatewayName !== null ? "-bottom-1 -right-1" : "right-0 bottom-0",
            props.accentColor
              ? "bg-[var(--provider-accent)] text-white"
              : "bg-muted text-muted-foreground",
            props.badgeClassName,
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        >
          {badgeContent === "initials" ? providerInstanceInitials(badgeLabel) : null}
        </span>
      ) : null}
    </span>
  );
});
