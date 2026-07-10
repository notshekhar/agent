import { describe, expect, test } from "bun:test";
import { countWheelScroll, isPrintableChar } from "../src/interactive/keys";

describe("countWheelScroll", () => {
    test("wheel up/down count with sign", () => {
        expect(countWheelScroll("\x1b[<64;10;5M")).toBe(-1);
        expect(countWheelScroll("\x1b[<65;10;5M")).toBe(1);
        // batched events in one chunk all count
        expect(countWheelScroll("\x1b[<65;10;5M\x1b[<65;10;5M\x1b[<64;10;5M")).toBe(1);
    });

    test("modifier bits on top of the wheel button still count", () => {
        expect(countWheelScroll("\x1b[<68;10;5M")).toBe(-1); // shift+wheel-up
        expect(countWheelScroll("\x1b[<81;10;5M")).toBe(1); // ctrl+wheel-down
    });

    test("horizontal tilt (66/67) is not vertical scroll", () => {
        expect(countWheelScroll("\x1b[<66;10;5M")).toBe(0);
        expect(countWheelScroll("\x1b[<67;10;5M")).toBe(0);
    });

    test("non-wheel buttons don't scroll", () => {
        expect(countWheelScroll("\x1b[<0;10;5M")).toBe(0); // left click
        expect(countWheelScroll("\x1b[<35;10;5M")).toBe(0); // motion
    });
});

describe("isPrintableChar", () => {
    test("plain letters and spaces are printable", () => {
        expect(isPrintableChar("a")).toBe(true);
        expect(isPrintableChar(" ")).toBe(true);
    });

    test("controls and DEL are not", () => {
        expect(isPrintableChar("\x03")).toBe(false);
        expect(isPrintableChar("\x7f")).toBe(false);
        expect(isPrintableChar("")).toBe(false);
    });

    test("multi-codeunit graphemes count as printable (emoji, IME commits)", () => {
        expect(isPrintableChar("😀")).toBe(true); // surrogate pair
        expect(isPrintableChar("नमस्ते")).toBe(true); // IME commit chunk
    });

    test("escape sequences are never printable", () => {
        expect(isPrintableChar("\x1b[A")).toBe(false); // arrow
        expect(isPrintableChar("\x1b\x1b[A")).toBe(false); // alt+arrow
        expect(isPrintableChar("\x1b[<65;10;5M")).toBe(false); // mouse
    });
});
