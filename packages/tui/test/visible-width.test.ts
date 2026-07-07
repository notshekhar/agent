import { describe, expect, test } from "bun:test";
import { setWidthCalibration, visibleWidth } from "../src/utils";

// visibleWidth must match how cell-grid terminals (no complex text shaping)
// lay out text, or the differential renderer's one-logical-line-per-row
// invariant breaks and streaming output smears (auto-wrap cursor drift).
// Reference model: wcwidth-style per-codepoint cells — Mn/Me/Cf/ignorables
// take no cell, Hangul V/T jamo compose into the leading jamo's cell,
// spacing combining marks (Mc) take one, everything else east-asian-width.

describe("visibleWidth", () => {
    const cases: [text: string, width: number, label: string][] = [
        // Indic scripts: conjuncts and matras span cells despite being one grapheme
        ["प्रे", 2, "Devanagari conjunct प्रे (pa+virama+ra+e-matra)"],
        ["प्रेमचंद", 5, "Devanagari word प्रेमचंद"],
        ["की", 2, "Devanagari ka + spacing matra ी (Mc takes a cell)"],
        ["जू", 1, "Devanagari ja + nonspacing matra ू (Mn takes none)"],
        ["कनपटी चिपकी, गालों की हड्डियाँ उभरी, पर मूँछें", 39, "Devanagari sentence from the streaming-smear bug report"],
        ["বাংলা", 5, "Bengali বাংলা"],
        ["தமிழ்", 4, "Tamil தமிழ்"],
        // Lone marks (streaming can split a cluster at a chunk boundary)
        ["ी", 1, "lone spacing matra ी"],
        ["्", 0, "lone virama (Mn)"],
        // Thai
        ["ที่", 1, "Thai ที่ (cons + two Mn marks)"],
        ["น้ำ", 2, "Thai น้ำ (SARA AM is a spacing letter)"],
        // Hangul: precomposed and decomposed must agree
        ["한", 2, "Hangul 한 precomposed"],
        ["한", 2, "Hangul 한 decomposed L+V+T jamo"],
        // CJK and width variants
        ["が", 2, "precomposed が"],
        ["が", 2, "か + combining dakuten"],
        ["中文", 4, "CJK wide"],
        ["ﾊﾝｶｸ", 4, "halfwidth katakana"],
        ["Ａ", 2, "fullwidth Ａ"],
        // Emoji
        ["\u{1F44D}", 2, "emoji"],
        ["\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}", 2, "RGI ZWJ family sequence"],
        ["\u{1F1EE}\u{1F1F3}", 2, "flag pair"],
        ["\u{1F1EE}", 2, "lone regional indicator (streaming split)"],
        // Latin + basics
        ["é", 1, "e + combining acute"],
        ["hello world", 11, "plain ASCII"],
        ["\t", 3, "tab"],
        ["", 0, "empty string"],
        ["\x1b[31mप्रे\x1b[0m", 2, "ANSI-wrapped Devanagari conjunct"],
    ];

    for (const [text, width, label] of cases) {
        test(`${label} = ${width}`, () => {
            expect(visibleWidth(text)).toBe(width);
        });
    }
});

describe("setWidthCalibration", () => {
    const defaults = { spacingMarkWidth: 1 as const, shapedClusters: false };

    test("reports no change when set to the defaults", () => {
        expect(setWidthCalibration(defaults)).toBe(false);
    });

    test("spacingMarkWidth 0 drops matra cells (and invalidates the cache)", () => {
        expect(visibleWidth("की")).toBe(2);
        try {
            expect(setWidthCalibration({ spacingMarkWidth: 0, shapedClusters: false })).toBe(true);
            expect(visibleWidth("की")).toBe(1);
            expect(visibleWidth("प्रे")).toBe(2);
        } finally {
            setWidthCalibration(defaults);
        }
        expect(visibleWidth("की")).toBe(2);
    });

    test("shapedClusters collapses a conjunct to its base cell", () => {
        try {
            expect(setWidthCalibration({ spacingMarkWidth: 0, shapedClusters: true })).toBe(true);
            expect(visibleWidth("प्रे")).toBe(1);
            expect(visibleWidth("プ")).toBe(2);
        } finally {
            setWidthCalibration(defaults);
        }
    });
});
