/**
 * Regenerates `src/components/LoopProviderIcons.tsx` from models.dev.
 *
 *     bun run scripts/generate-provider-icons.ts
 *
 * models.dev is already loop's model catalog source (see
 * packages/core/src/catalog), and it serves a brand mark per provider at
 * `/logos/<id>.svg`. Taking the icons from the same place as the models keeps
 * one id namespace instead of two, and means a provider added to the catalog
 * usually already has a mark waiting.
 *
 * The output is committed. This is a vendoring step, not a build step: the
 * desktop app must render its own settings screen with no network, and a
 * remote fetch on a settings page would also leak which providers a user is
 * looking at to a third party.
 *
 * Two traps, both measured against the live endpoint:
 *
 *   1. **Unknown ids return 200, not 404.** models.dev answers with a generic
 *      three-sparkles placeholder, so a typo'd id yields a plausible-looking
 *      icon rather than an error. Every response is compared against that
 *      placeholder and rejected if it matches — `ollama` genuinely has no mark
 *      there and is caught by exactly this check.
 *   2. **Not every mark is monochrome.** Most are a single `currentColor`
 *      path, but some (zenmux) ship a light-mode background plate and literal
 *      fills, which would render as a white square in dark mode. Those are
 *      normalized to `currentColor` and their full-bleed background rect is
 *      dropped.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(HERE, "..", "src", "components", "LoopProviderIcons.tsx");
const LOGOS = "https://models.dev/logos";

/**
 * loop provider id → the component name, and the models.dev id to fetch.
 *
 * The two ids disagree more often than not, which is the whole reason this
 * table is explicit: loop splits Zhipu into `glm` (China) and `zai`
 * (international) where models.dev has one `zhipuai`, and loop's `kimi` is
 * models.dev's `moonshotai`.
 */
const ICONS: ReadonlyArray<{
  component: string;
  modelsDevId: string;
  /** Tried when `modelsDevId` comes back as the placeholder. */
  fallbackId?: string;
  note?: string;
}> = [
  { component: "AnthropicIcon", modelsDevId: "anthropic" },
  { component: "OpenAiIcon", modelsDevId: "openai" },
  { component: "GoogleAiIcon", modelsDevId: "google" },
  { component: "XaiIcon", modelsDevId: "xai" },
  { component: "OpenRouterIcon", modelsDevId: "openrouter" },
  { component: "CopilotIcon", modelsDevId: "github-copilot" },
  { component: "DeepSeekIcon", modelsDevId: "deepseek" },
  { component: "MistralIcon", modelsDevId: "mistral" },
  { component: "ZhipuIcon", modelsDevId: "zhipuai", note: "loop's glm + zai both ride this mark" },
  { component: "MoonshotIcon", modelsDevId: "moonshotai", note: "loop calls this provider kimi" },
  { component: "GroqIcon", modelsDevId: "groq" },
  { component: "CerebrasIcon", modelsDevId: "cerebras" },
  { component: "ZenMuxIcon", modelsDevId: "zenmux" },
  { component: "VercelIcon", modelsDevId: "vercel" },
  { component: "BedrockIcon", modelsDevId: "amazon-bedrock" },
  {
    component: "OllamaIcon",
    modelsDevId: "ollama",
    // models.dev has no `ollama` mark — it answers with the placeholder. Its
    // `ollama-cloud` entry is the plain llama face (outline, muzzle, two
    // eyes) with nothing cloud-specific in it, so it is the right mark for a
    // local Ollama too.
    fallbackId: "ollama-cloud",
  },
];

/** An id models.dev cannot possibly know, used to learn its placeholder body. */
const PROBE_ID = "loop-placeholder-probe";

const ATTRIBUTES: Record<string, string> = {
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-miterlimit": "strokeMiterlimit",
  "stroke-dasharray": "strokeDasharray",
  "shape-rendering": "shapeRendering",
  "clip-path": "clipPath",
  "fill-opacity": "fillOpacity",
  "stroke-opacity": "strokeOpacity",
  "stop-color": "stopColor",
  "stop-opacity": "stopOpacity",
  "xlink:href": "xlinkHref",
};

async function fetchLogo(id: string): Promise<string> {
  const res = await fetch(`${LOGOS}/${id}.svg`);
  if (!res.ok) throw new Error(`${id}: models.dev answered ${res.status}`);
  return await res.text();
}

function viewBoxOf(svg: string): string {
  return /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 24 24";
}

function bodyOf(svg: string): string {
  const open = svg.indexOf(">", svg.indexOf("<svg"));
  const close = svg.lastIndexOf("</svg>");
  return svg.slice(open + 1, close).trim();
}

/** Collapse whitespace so a reformatted placeholder still compares equal. */
function normalizeForCompare(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/**
 * Force a mark to inherit its colour.
 *
 * Only touches literal paint (`#hex`, `black`, `white`) — `fill="none"` is
 * structural (it marks a stroke-only shape) and must survive. The `style`
 * attribute duplicates the same paint in `color(display-p3 …)` form, which
 * would win over the attribute, so it is dropped wholesale.
 */
function forceCurrentColor(body: string): string {
  return body
    .replace(/\s+style="[^"]*"/g, "")
    .replace(/(fill|stroke)="(#[0-9a-fA-F]{3,8}|black|white)"/g, '$1="currentColor"');
}

/**
 * Drop a full-bleed background plate.
 *
 * A `<rect>` covering the whole viewBox is a light-mode backdrop, not part of
 * the mark; left in and recoloured it would paint a solid block over the glyph.
 */
function dropBackgroundPlate(body: string, viewBox: string): string {
  const [, , width, height] = viewBox.split(/\s+/).map(Number);
  if (width === undefined || height === undefined) return body;
  return body.replace(/<rect\b[^>]*\/?>(?:<\/rect>)?/g, (rect) => {
    const rectWidth = Number(/\bwidth="([\d.]+)"/.exec(rect)?.[1]);
    const rectHeight = Number(/\bheight="([\d.]+)"/.exec(rect)?.[1]);
    return rectWidth >= width && rectHeight >= height ? "" : rect;
  });
}

function toJsx(body: string): string {
  const renamed = body.replace(
    /\b([a-zA-Z-]+(?::[a-zA-Z-]+)?)=(?=")/g,
    (_match, name: string) => `${ATTRIBUTES[name] ?? name}=`,
  );
  return renamed
    .replace(/><\/(path|circle|rect|stop|polygon|ellipse|line|use)>/g, " />")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function indent(body: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return body
    .split("\n")
    .map((line) => (line.trim() ? pad + line.trim() : ""))
    .join("\n");
}

const HEADER = `/**
 * Brand marks for the model providers loop can talk to.
 *
 * GENERATED — run \`bun run scripts/generate-provider-icons.ts\` to refresh.
 * Do not hand-edit; see that script for where these come from and why they are
 * committed rather than fetched.
 *
 * Distinct from \`Icons.tsx\`, which holds the marks the upstream UI shipped
 * with — those identify *coding agents* (Codex, Cursor, OpenCode). These
 * identify the model vendors and gateways behind \`loop login\`.
 *
 * Every mark paints with \`currentColor\`, so a row inherits its text colour
 * and reads correctly in both themes. The marks remain the trademarks of their
 * owners and appear only to identify the service each row connects to.
 */
import { cn } from "~/lib/utils";
import type { Icon } from "./Icons";
`;

async function main(): Promise<void> {
  const placeholder = normalizeForCompare(bodyOf(await fetchLogo(PROBE_ID)));

  const parts: string[] = [HEADER];
  const missing: string[] = [];

  for (const { component, modelsDevId, fallbackId, note } of ICONS) {
    let svg = await fetchLogo(modelsDevId);
    if (normalizeForCompare(bodyOf(svg)) === placeholder && fallbackId !== undefined) {
      svg = await fetchLogo(fallbackId);
    }
    const viewBox = viewBoxOf(svg);
    const raw = bodyOf(svg);
    if (normalizeForCompare(raw) === placeholder) {
      missing.push(modelsDevId);
      continue;
    }
    const body = toJsx(dropBackgroundPlate(forceCurrentColor(raw), viewBox));
    const comment = note ? `/** ${note}. */\n` : "";
    parts.push(
      `${comment}export const ${component}: Icon = ({ className, ...props }) => (
  <svg
    viewBox="${viewBox}"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={cn("size-4", className)}
    {...props}
  >
${indent(body, 4)}
  </svg>
);
`,
    );
  }

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, parts.join("\n"), "utf8");
  console.log(`wrote ${OUTPUT} (${ICONS.length - missing.length} marks)`);
  if (missing.length > 0) {
    console.log(
      `models.dev has no mark for: ${missing.join(", ")} — it answered with its placeholder.\n` +
        `Add these by hand below the generated block, or they fall back to a lettermark.`,
    );
  }
}

await main();
