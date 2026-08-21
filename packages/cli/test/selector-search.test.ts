import { describe, expect, test } from "bun:test";
import { fuzzyFilter, type SelectItem } from "@notshekhar/loop-tui";

/**
 * What a picker's search has to survive: model ids.
 *
 * They carry their own punctuation — `custom:pronto-gpt/openai/gpt-5.6-sol` —
 * so a substring test cannot find one by the two words you remember. "openai
 * sol" contains a space, which appears nowhere in any id, and "gpt5sol" is the
 * name with its punctuation left out. Both used to return nothing, which reads
 * as the search being broken rather than the query being wrong.
 *
 * This is the same matcher the editor's completion menu uses; these tests pin
 * the behaviour the pickers depend on, and the shape of the filter built on it.
 */
const MODELS: SelectItem[] = [
    { value: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8" },
    { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { value: "custom:pronto-gpt/openai/gpt-5.6-sol", label: "Gpt 5.6 Sol" },
    { value: "openai/gpt-5-mini", label: "GPT-5 mini" },
    { value: "google/gemini-3-pro", label: "Gemini 3 Pro" },
    { value: "kimi/k3", label: "Kimi K3", description: "moonshot's long-context model" },
];

/** The picker's filter: fuzzy over label+value, then substring over description. */
function filterItems(items: SelectItem[], query: string): SelectItem[] {
    if (!query.trim()) return items;
    const ranked = fuzzyFilter(items, query, (item) => `${item.label} ${item.value}`);
    const seen = new Set(ranked);
    const q = query.toLowerCase();
    const byDescription = items.filter((item) => !seen.has(item) && (item.description ?? "").toLowerCase().includes(q));
    return [...ranked, ...byDescription];
}

const values = (items: SelectItem[]) => items.map((i) => i.value);

describe("picker search", () => {
    test("a space between two words you remember finds the model", () => {
        // No id contains a space, so a substring test found nothing at all.
        expect(values(filterItems(MODELS, "openai sol"))).toEqual(["custom:pronto-gpt/openai/gpt-5.6-sol"]);
        expect(values(filterItems(MODELS, "claude sonnet"))).toEqual(["anthropic/claude-sonnet-4-5"]);
    });

    test("the name without its punctuation finds it too", () => {
        expect(values(filterItems(MODELS, "gpt5sol"))).toContain("custom:pronto-gpt/openai/gpt-5.6-sol");
        expect(values(filterItems(MODELS, "gemini3"))).toContain("google/gemini-3-pro");
    });

    test("the closest match comes first", () => {
        // Both contain the letters; the one where they are the actual name wins.
        expect(values(filterItems(MODELS, "sol"))[0]).toBe("custom:pronto-gpt/openai/gpt-5.6-sol");
        expect(values(filterItems(MODELS, "opus"))[0]).toBe("anthropic/claude-opus-4-8");
    });

    test("every token has to match — it does not widen the list", () => {
        expect(filterItems(MODELS, "claude gemini")).toEqual([]);
        expect(filterItems(MODELS, "nonsense")).toEqual([]);
    });

    test("plain substring search still works, including on descriptions", () => {
        expect(values(filterItems(MODELS, "anthropic"))).toEqual([
            "anthropic/claude-opus-4-8",
            "anthropic/claude-sonnet-4-5",
        ]);
        expect(values(filterItems(MODELS, "moonshot"))).toEqual(["kimi/k3"]);
    });

    test("an empty query is the whole list, untouched", () => {
        expect(filterItems(MODELS, "")).toEqual(MODELS);
        expect(filterItems(MODELS, "   ")).toEqual(MODELS);
    });
});
