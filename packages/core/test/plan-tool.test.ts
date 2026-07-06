import { describe, expect, test } from "bun:test";
import { isDeliveredPlan, normalizePlanText, PLAN_MIN_CHARS, planDeliveredThisStep } from "../src/tools/plan";

const FULL_PLAN = `# Title\n\n## Steps\n${"1. do the thing in file.ts\n".repeat(15)}## Risks\nnone`;

describe("isDeliveredPlan", () => {
    test("accepts a document, rejects stubs and junk", () => {
        expect(FULL_PLAN.length).toBeGreaterThanOrEqual(PLAN_MIN_CHARS);
        expect(isDeliveredPlan({ plan: FULL_PLAN })).toBe(true);
        expect(isDeliveredPlan({ plan: "# Just a title" })).toBe(false);
        expect(isDeliveredPlan({ plan: 42 })).toBe(false);
        expect(isDeliveredPlan(undefined)).toBe(false);
    });
});

describe("planDeliveredThisStep", () => {
    test("stops only on a substantial plan call in the LAST step", () => {
        const stub = { toolCalls: [{ toolName: "plan", input: { plan: "# Title" } }] };
        const full = { toolCalls: [{ toolName: "plan", input: { plan: FULL_PLAN } }] };
        const other = { toolCalls: [{ toolName: "read", input: { path: "x" } }] };
        expect(planDeliveredThisStep({ steps: [stub] })).toBe(false);
        expect(planDeliveredThisStep({ steps: [stub, full] })).toBe(true);
        expect(planDeliveredThisStep({ steps: [full, other] })).toBe(false); // earlier step doesn't count
        expect(planDeliveredThisStep({ steps: [] })).toBe(false);
    });
});

describe("normalizePlanText", () => {
    test("unescapes a single-line plan full of literal \\n", () => {
        const escaped = "# Title\\n\\n## Steps\\n1. one\\n2. two";
        expect(normalizePlanText(escaped)).toBe("# Title\n\n## Steps\n1. one\n2. two");
    });

    test("leaves a real multi-line plan alone, even when it mentions \\n", () => {
        const legit = '# Title\n\n## Steps\n1. print "a\\nb" with the escape\n2. done\n3. more\n4. lines';
        expect(normalizePlanText(legit)).toBe(legit);
    });
});
