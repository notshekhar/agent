import { afterEach, describe, expect, test } from "bun:test";
import {
    clearToolVerbGroups,
    foldsEagerly,
    kindIdOf,
    registerToolVerbGroup,
    verbGroupLabel,
} from "../src/interactive/ui/verb-group";

afterEach(() => clearToolVerbGroups());

const member = (toolName: string, extra: Partial<{ isError: boolean; isRunning: boolean }> = {}) => ({
    toolName,
    isError: false,
    isRunning: false,
    ...extra,
});

describe("classification", () => {
    test("builtin tools map to their kind", () => {
        expect(kindIdOf("read")).toBe("file");
        expect(kindIdOf("ls")).toBe("dir");
        expect(kindIdOf("grep")).toBe("search");
        expect(kindIdOf("bash")).toBe("command");
        expect(kindIdOf("task")).toBe("subagent");
    });

    test("only kinds whose detail is noise fold; the rest keep their rows", () => {
        for (const t of ["read", "ls", "grep", "webfetch", "task"]) expect(foldsEagerly(t)).toBe(true);
        // The command that ran and the file that changed ARE the information.
        for (const t of ["bash", "edit", "write"]) expect(foldsEagerly(t)).toBe(false);
    });
});

describe("third-party tools", () => {
    test("an unknown tool never folds — staying visible is the safe failure", () => {
        expect(kindIdOf("frobnicate")).toBe("other");
        expect(foldsEagerly("frobnicate")).toBe(false);
    });

    test("a transparent verb_noun name classifies itself", () => {
        // The overwhelmingly common shape for extension and MCP tools.
        expect(kindIdOf("search_issues")).toBe("search");
        expect(kindIdOf("list_repos")).toBe("dir");
        expect(kindIdOf("fetch_page")).toBe("web");
        expect(kindIdOf("read_document")).toBe("file");
        expect(foldsEagerly("search_issues")).toBe(true);
    });

    test("the heuristic stays conservative where a guess would mislead", () => {
        // `get_*` is as often a mutation-adjacent RPC as a read, and `run_*`
        // says nothing about what ran — a wrong guess here would hide a row
        // under a label that misdescribes it.
        expect(kindIdOf("get_user")).toBe("other");
        expect(kindIdOf("run_pipeline")).toBe("other");
        // A verb has to lead, not merely appear.
        expect(kindIdOf("deep_search_helper")).toBe("other");
    });

    test("MCP tools classify on the tool half and fall back to the MCP bucket", () => {
        expect(kindIdOf("github__search_issues")).toBe("search");
        expect(kindIdOf("github__frobnicate")).toBe("mcp");
    });

    test("an explicit registration beats both the builtin table and the name", () => {
        registerToolVerbGroup("frobnicate", "web");
        expect(kindIdOf("frobnicate")).toBe("web");
        expect(foldsEagerly("frobnicate")).toBe(true);

        // Even when the name actively lies about what the tool does.
        registerToolVerbGroup("search_nothing", "command");
        expect(kindIdOf("search_nothing")).toBe("command");
    });
});

describe("labels", () => {
    test("one segment per kind, in first-seen order", () => {
        const { text } = verbGroupLabel([member("ls"), member("ls"), member("read")]);
        expect(text).toBe("Listed 2 dirs, Read 1 file");
    });

    test("different tools of the same kind merge into one segment", () => {
        expect(verbGroupLabel([member("grep"), member("glob")]).text).toBe("Searched 2 patterns");
    });

    test("nouns agree with their count", () => {
        expect(verbGroupLabel([member("read")]).text).toBe("Read 1 file");
        expect(verbGroupLabel([member("read"), member("read")]).text).toBe("Read 2 files");
    });

    test("a still-running run reads present tense", () => {
        expect(verbGroupLabel([member("read", { isRunning: true })]).text).toBe("Reading 1 file");
        // One running member makes the whole run present tense — the run as a
        // whole is still happening.
        expect(verbGroupLabel([member("read"), member("read", { isRunning: true })]).text).toBe("Reading 2 files");
    });

    test("failures are counted so a fold can't swallow bad news", () => {
        const { text, failed } = verbGroupLabel([member("read"), member("read", { isError: true })]);
        expect(text).toBe("Read 2 files");
        expect(failed).toBe(1);
    });

    test("an unclassified tool still gets a truthful segment", () => {
        expect(verbGroupLabel([member("frobnicate"), member("frobnicate")]).text).toBe("Ran 2 tools");
    });
});
