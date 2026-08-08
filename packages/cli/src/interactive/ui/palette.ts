/**
 * The shared colour system every built-in theme is generated from.
 *
 * A `ThemeJson` has ~55 slots. Writing those out per theme meant four
 * near-identical tables that drifted apart the moment one was edited, and each
 * new UI mode copied them again. So themes here declare a `Palette` — about
 * twenty primitives — and `themeFromPalette` derives every slot from it. Change
 * how a slot relates to the palette once and all themes, in all modes, follow.
 *
 * The primitives are the desktop app's design tokens (`apps/web/src/index.css`)
 * so the CLI and the desktop read as one product; the derived relationships
 * (how far a tint lifts off the canvas, which ramp step a slot lands on) are
 * this file's business.
 *
 * `ThemeJson` stays the wire format: custom themes in ~/.loop and themes
 * contributed by extensions are still authored slot-by-slot, and still load.
 */

export interface ThemeColors {
    accent: string | number;
    border: string | number;
    borderAccent: string | number;
    borderMuted: string | number;
    success: string | number;
    error: string | number;
    warning: string | number;
    muted: string | number;
    dim: string | number;
    text: string | number;
    thinkingText: string | number;
    selectedBg: string | number;
    userMessageBg: string | number;
    userMessageText: string | number;
    customMessageBg: string | number;
    customMessageText: string | number;
    customMessageLabel: string | number;
    toolPendingBg: string | number;
    toolSuccessBg: string | number;
    toolErrorBg: string | number;
    toolTitle: string | number;
    toolOutput: string | number;
    /** Failed tool title/output — vivid, unlike the muted `error`/diff red. */
    toolError: string | number;
    mdHeading: string | number;
    mdLink: string | number;
    mdLinkUrl: string | number;
    mdCode: string | number;
    mdCodeBlock: string | number;
    mdCodeBlockBorder: string | number;
    mdQuote: string | number;
    mdQuoteBorder: string | number;
    mdHr: string | number;
    mdListBullet: string | number;
    toolDiffAdded: string | number;
    toolDiffRemoved: string | number;
    toolDiffContext: string | number;
    syntaxComment: string | number;
    syntaxKeyword: string | number;
    syntaxFunction: string | number;
    syntaxVariable: string | number;
    syntaxString: string | number;
    syntaxNumber: string | number;
    syntaxType: string | number;
    syntaxOperator: string | number;
    syntaxPunctuation: string | number;
    thinkingOff: string | number;
    thinkingMinimal: string | number;
    thinkingLow: string | number;
    thinkingMedium: string | number;
    thinkingHigh: string | number;
    thinkingXhigh: string | number;
    bashMode: string | number;
    /** Composer chrome: the rules above and below the input, and the tint on a
     * `/command` token as it is typed. */
    inputBorder: string | number;
    inputCommand: string | number;
    /** Injected context: session-start hook output, the active agent badge. */
    hookAccent: string | number;
    /** UI-mode slots — optional ("" = terminal default). Modes that wash the
     * canvas or draw per-block accents define these in their own themes; the
     * loop themes carry neutral values so any renderer can reference them. */
    bgBase?: string | number;
    bgRaised?: string | number;
    accentUser?: string | number;
    accentAssistant?: string | number;
    accentThinking?: string | number;
    accentTool?: string | number;
    timestamp?: string | number;
    selectionBorder?: string | number;
    turnSummary?: string | number;
}

export interface ThemeJson {
    name: string;
    vars?: Record<string, string | number>;
    colors: ThemeColors;
}

/** The nine scopes loop maps highlight.js onto. */
export interface SyntaxPalette {
    comment: string;
    keyword: string;
    function: string;
    variable: string;
    string: string;
    number: string;
    type: string;
    operator: string;
    punctuation: string;
}

export interface Palette {
    /** Theme name, as shown in /theme and stored in settings. */
    name: string;
    /** True for palettes meant for a light terminal. */
    light: boolean;
    /**
     * Paint `bg` across the canvas (OSC 11). Modes that do not wash still need
     * a concrete `bg` — every tint below is computed against it — they just do
     * not claim the terminal's background as their own.
     */
    wash: boolean;

    /** The canvas. */
    bg: string;
    /** Lifted off the canvas: user messages, raised panels. */
    bgRaised: string;
    /** Recessed box fill: tool output boxes. */
    bgSunken: string;

    /** Text ramp, strongest to faintest. */
    text: string;
    muted: string;
    dim: string;
    /** Chrome: box borders, horizontal rules, the composer's edges. */
    line: string;

    /**
     * How tool calls carry their state.
     *
     * "flat" — every box stays the neutral recessed surface and the state
     * lives entirely in the title glyph. This is `noir`'s design: it renders
     * tools as one-line rows, and a coloured fill behind a single row reads as
     * a highlight bar rather than a box.
     *
     * Otherwise, explicit fills: the box itself takes the state colour, the
     * way `loop` mode has always drawn tool calls. These are given rather than
     * derived on purpose. Mixing the semantic ink into a surface produced
     * fills that were technically the right hue and visibly wrong — muddier
     * and less separated than the hand-picked ones, because a box fill needs
     * far more hue than its share of a linear blend gives it.
     */
    toolSurfaces: "flat" | { pending: string; success: string; error: string };

    /** Brand colour, and a lifted step of it for links and secondary accents. */
    accent: string;
    accentLift: string;

    success: string;
    error: string;
    warning: string;

    /**
     * Markdown's own two colours. Everything else in a rendered message reuses
     * a colour the palette already has — links take the lifted accent, quotes
     * the muted text, code blocks the success green — but a heading and an
     * inline `code` span need hues of their own. Without them both collapse
     * onto the accent and a message renders in one flat colour: heading, link,
     * code and bullet all the same blue.
     */
    heading: string;
    inlineCode: string;

    syntax: SyntaxPalette;
    /** Top rung of the thinking-effort ladder — deliberately off-hue from the
     * accent so "xhigh" is unmistakable. */
    thinkingPeak: string;
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

function rgb(hex: string): [number, number, number] {
    const c = hex.replace("#", "");
    return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function hex(c: readonly [number, number, number]): string {
    return `#${c
        .map((v) =>
            Math.round(Math.min(255, Math.max(0, v)))
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")}`;
}

/** `t` of the way from `a` to `b`. */
export function mix(a: string, b: string, t: number): string {
    const [ar, ag, ab] = rgb(a);
    const [br, bg, bb] = rgb(b);
    return hex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/** `amount` of `color` laid over the canvas — how every surface tint is built. */
function tint(palette: Palette, color: string, amount: number): string {
    return mix(palette.bg, color, amount);
}

/** Relative luminance, for deciding whether a colour reads as light or dark. */
export function luminance(hexColor: string): number {
    const [r, g, b] = rgb(hexColor);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * How far each surface tint lifts off the canvas. Kept together so the
 * hierarchy — selection reads strongest, a custom message barely whispers — is
 * legible as a set rather than scattered across four theme files.
 */
const TINT = {
    selection: 0.16,
    customMessage: 0.07,
    /** Failure surface for palettes that keep their boxes flat otherwise. */
    errorSurface: 0.15,
} as const;

/** Build the full slot table for a palette. */
export function themeFromPalette(p: Palette): ThemeJson {
    return {
        name: p.name,
        colors: {
            accent: p.accent,
            // Chrome stays neutral and the brand colour is reserved for focus,
            // selection and emphasis — the desktop's rule, and the reason its
            // blue reads as meaningful rather than decorative.
            border: p.line,
            borderAccent: p.accent,
            borderMuted: p.line,
            success: p.success,
            error: p.error,
            warning: p.warning,
            muted: p.muted,
            dim: p.dim,
            text: p.text,
            thinkingText: p.muted,

            selectedBg: tint(p, p.accent, TINT.selection),
            userMessageBg: p.bgRaised,
            userMessageText: p.text,
            customMessageBg: tint(p, p.accent, TINT.customMessage),
            customMessageText: p.text,
            customMessageLabel: p.accentLift,

            toolPendingBg: p.toolSurfaces === "flat" ? p.bgSunken : p.toolSurfaces.pending,
            toolSuccessBg: p.toolSurfaces === "flat" ? p.bgSunken : p.toolSurfaces.success,
            // Failure gets a surface either way — a red row is worth spotting
            // from across the transcript, and noir's own theme tinted it too.
            toolErrorBg: p.toolSurfaces === "flat" ? mix(p.bgRaised, p.error, TINT.errorSurface) : p.toolSurfaces.error,
            toolTitle: p.text,
            toolOutput: p.muted,
            toolError: p.error,

            // Headings carry the brand colour. The desktop leans on weight
            // alone, but a terminal transcript has no whitespace or type scale
            // to separate sections with — without colour a heading reads as
            // just another bold line.
            mdHeading: p.heading,
            mdLink: p.accentLift,
            mdLinkUrl: p.dim,
            mdCode: p.inlineCode,
            // Fenced blocks whose language is unknown — anything loop can
            // identify goes through the syntax palette instead.
            mdCodeBlock: p.success,
            mdCodeBlockBorder: p.dim,
            mdQuote: p.muted,
            mdQuoteBorder: p.dim,
            mdHr: p.dim,
            mdListBullet: p.accent,

            toolDiffAdded: p.success,
            toolDiffRemoved: p.error,
            toolDiffContext: p.muted,

            syntaxComment: p.syntax.comment,
            syntaxKeyword: p.syntax.keyword,
            syntaxFunction: p.syntax.function,
            syntaxVariable: p.syntax.variable,
            syntaxString: p.syntax.string,
            syntaxNumber: p.syntax.number,
            syntaxType: p.syntax.type,
            syntaxOperator: p.syntax.operator,
            syntaxPunctuation: p.syntax.punctuation,

            // The effort ladder climbs the brand hue — grey while off, then
            // deepening blue, then off-hue at the top so xhigh stands apart.
            thinkingOff: p.line,
            thinkingMinimal: p.dim,
            thinkingLow: mix(p.accent, p.bg, 0.25),
            thinkingMedium: p.accent,
            thinkingHigh: p.accentLift,
            thinkingXhigh: p.thinkingPeak,

            bashMode: p.success,
            inputBorder: p.line,
            inputCommand: p.accent,
            // Content loop injected rather than the model or you writing it —
            // session-start hook output, the non-default agent badge. Orange
            // because it is the one hue nothing else in the transcript uses.
            hookAccent: p.syntax.variable,

            bgBase: p.wash ? p.bg : "",
            bgRaised: p.bgRaised,
            accentUser: p.accent,
            accentAssistant: p.text,
            accentThinking: p.muted,
            accentTool: p.dim,
            timestamp: p.dim,
            selectionBorder: p.accent,
            turnSummary: p.dim,
        },
    };
}

// ---------------------------------------------------------------------------
// Shared ingredients
// ---------------------------------------------------------------------------

/**
 * The brand blue. The desktop's `--primary` at full chroma — oklch(L 0.217 264)
 * — is punchy behind a button but relentless as a terminal's accent, where it
 * lands on borders, bullets, gutters and prompts all at once. These sit a few
 * chroma steps back (0.16) at the same lightness and hue: recognisably the
 * same blue, calm enough to live on every surface.
 */
export const PRIMARY_DARK = "#4a77db";
export const PRIMARY_LIGHT = "#2f58b9";

/** pierre-dark — the shiki theme the desktop app highlights code with. */
export const SYNTAX_DARK: SyntaxPalette = {
    comment: "#737373",
    keyword: "#ff678d",
    function: "#9d6afb",
    variable: "#ffa359",
    string: "#5ecc71",
    number: "#68cdf2",
    type: "#d568ea",
    operator: "#8a8a8a",
    punctuation: "#8a8a8a",
};

/** pierre-light, its counterpart. */
export const SYNTAX_LIGHT: SyntaxPalette = {
    comment: "#737373",
    keyword: "#d32a61",
    function: "#693acf",
    variable: "#d47628",
    string: "#199f43",
    number: "#1ca1c7",
    type: "#a631be",
    operator: "#636363",
    punctuation: "#636363",
};

/**
 * The dark half of the desktop's token set, shared by every dark palette.
 * Individual palettes override the surface levels — `loop` mode draws on the
 * user's own terminal background and needs more contrast than `noir`, which
 * owns the canvas.
 */
export const DARK_INK = {
    light: false,
    text: "#f5f5f5",
    muted: "#8a8a8a",
    dim: "#5f5f5f",
    accent: PRIMARY_DARK,
    accentLift: "#659ff4",
    // Muted semantics rather than the desktop's saturated emerald/red/amber.
    // Those are sized for a small badge on a white card; at terminal scale —
    // whole output lines, diffs, box titles — they glare.
    success: "#8aa872",
    error: "#e06c75",
    warning: "#e5c07b",
    // Gold headings and a magenta inline span — markdown's long-standing
    // colours here. The magenta is the syntax palette's own type colour, so an
    // inline `Foo` matches the `Foo` in the code block under it.
    heading: "#e5c07b",
    inlineCode: "#d568ea",
    syntax: SYNTAX_DARK,
    thinkingPeak: "#9d6afb",
} as const;

/** The light half of the same token set. */
export const LIGHT_INK = {
    light: true,
    text: "#27272a",
    muted: "#71717b",
    dim: "#8b8b95",
    accent: PRIMARY_LIGHT,
    accentLift: "#3a6cce",
    success: "#15803d",
    error: "#c1453f",
    warning: "#a16207",
    heading: "#a16207",
    inlineCode: "#a631be",
    syntax: SYNTAX_LIGHT,
    thinkingPeak: "#a631be",
} as const;
