import { ProviderDriverKind } from "@loop/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { rememberCustomProviderShapes } from "../../loop/providers";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

const kind = (id: string) => ProviderDriverKind.make(id);

/**
 * A custom gateway has no brand of its own — bifrost, LiteLLM and a hand-rolled
 * proxy are all just an endpoint — so it borrows the mark of the API it speaks.
 * That makes two gateways in front of the same vendor draw identically, which
 * is exactly what the model-picker rail showed: an Anthropic mark and an OpenAI
 * mark, with nothing saying either was a gateway or which one it was. The
 * initials badge under the mark is the only identity they have.
 */
describe("the mark for a custom gateway", () => {
  it("badges the borrowed icon with the gateway's initials", () => {
    rememberCustomProviderShapes([
      ["pronto-claude", "anthropic"],
      ["pronto-gpt", "openai"],
    ]);
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon
        driverKind={kind("custom__pronto-claude")}
        displayName="pronto-claude"
      />,
    );
    expect(markup).toContain("PC");
    // Just outside the bottom-right corner. Tucked inside the icon's own box
    // it reads as part of the vendor's logo; the status dot owns top-left.
    expect(markup).toContain("-bottom-1 -right-1");
  });

  /**
   * The sidebar rail passes `showBadge={false}` when a driver has only one
   * instance — it is answering "is there more than one Codex?", a different
   * question. A gateway's badge is not that annotation and must survive it.
   */
  it("keeps the badge even when the caller says it is not a duplicate", () => {
    rememberCustomProviderShapes([["pronto-gpt", "openai"]]);
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon
        driverKind={kind("custom__pronto-gpt")}
        displayName="pronto-gpt"
        showBadge={false}
      />,
    );
    expect(markup).toContain("PG");
  });

  it("leaves a built-in provider unbadged when it is the only one of its kind", () => {
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon driverKind={kind("anthropic")} displayName="Anthropic" />,
    );
    expect(markup).not.toContain("AN");
  });

  /**
   * Until loop has reported what a gateway speaks there is nothing true to
   * draw, so the lettermark stands in rather than a guessed brand.
   */
  it("falls back to a lettermark for a gateway whose shape is not yet known", () => {
    rememberCustomProviderShapes([]);
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon driverKind={kind("custom__mystery")} displayName="mystery" />,
    );
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("MY");
  });
});
