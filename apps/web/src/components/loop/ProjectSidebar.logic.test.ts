import type { EnvironmentId, ProjectId } from "@loop/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectSidebarRows,
  formatSessionCountLabel,
  compactTimeLabel,
  resolveActiveProjectId,
  sessionsForProject,
  SIDEBAR_SESSIONS_PER_PROJECT,
  SIDEBAR_SETTLED_PAGE,
  type ProjectSidebarProjectInput,
  type ProjectSidebarThreadInput,
} from "./ProjectSidebar.logic";

const LOCAL = "local" as EnvironmentId;

function project(id: string, updatedAt: string): ProjectSidebarProjectInput {
  return {
    id: id as ProjectId,
    environmentId: LOCAL,
    title: id.slice(id.lastIndexOf("/") + 1),
    workspaceRoot: id,
    updatedAt,
  };
}

function thread(
  id: string,
  projectId: string,
  updatedAt: string,
  status?: string,
): ProjectSidebarThreadInput {
  return {
    id,
    environmentId: LOCAL,
    projectId,
    updatedAt,
    session: status === undefined ? null : { status },
  };
}

describe("project sidebar rows", () => {
  it("counts a project's sessions and the running ones", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "2026-08-01T00:00:00.000Z")],
      threads: [
        thread("1", "/a", "2026-08-01T00:00:00.000Z"),
        thread("2", "/a", "2026-08-02T00:00:00.000Z", "running"),
        thread("3", "/a", "2026-08-03T00:00:00.000Z", "idle"),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionCount).toBe(3);
    expect(rows[0]?.runningCount).toBe(1);
  });

  it("dates a project by its newest session, not by the project record", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "2020-01-01T00:00:00.000Z")],
      threads: [
        thread("1", "/a", "2026-08-01T00:00:00.000Z"),
        thread("2", "/a", "2026-08-05T00:00:00.000Z"),
      ],
    });

    expect(rows[0]?.lastActivity).toBe(Date.parse("2026-08-05T00:00:00.000Z"));
  });

  it("falls back to the project's own timestamp when it has no sessions", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "2026-08-01T00:00:00.000Z")],
      threads: [],
    });

    expect(rows[0]?.sessionCount).toBe(0);
    expect(rows[0]?.lastActivity).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
  });

  it("puts the most recently touched folder first", () => {
    const rows = buildProjectSidebarRows({
      projects: [
        project("/old", "2026-01-01T00:00:00.000Z"),
        project("/new", "2026-01-01T00:00:00.000Z"),
      ],
      threads: [
        thread("1", "/old", "2026-08-01T00:00:00.000Z"),
        thread("2", "/new", "2026-08-05T00:00:00.000Z"),
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["/new", "/old"]);
  });

  it("does not date a project by an unparseable timestamp", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "not a date")],
      threads: [thread("1", "/a", "also not a date")],
    });

    expect(rows[0]?.lastActivity).toBe(0);
  });

  it("ignores sessions belonging to another project", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "2026-08-01T00:00:00.000Z")],
      threads: [thread("1", "/b", "2026-08-01T00:00:00.000Z")],
    });

    expect(rows[0]?.sessionCount).toBe(0);
  });
});

describe("session count label", () => {
  it("reads as a sentence at every count", () => {
    expect(formatSessionCountLabel(0)).toBe("No sessions");
    expect(formatSessionCountLabel(1)).toBe("1 session");
    expect(formatSessionCountLabel(2)).toBe("2 sessions");
  });
});

describe("a project's sessions in the sidebar", () => {
  // Built from an epoch rather than formatted by hand: `00:79:00` is not a
  // time, and Date.parse returns NaN for it, which quietly scrambles the sort.
  const at = (minutes: number) =>
    new Date(Date.parse("2026-08-07T00:00:00.000Z") + minutes * 60_000).toISOString();
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...thread(`t${index}`, "/a", at(index)),
      title: `session ${index}`,
    }));

  it("lists them newest first", () => {
    const { active } = sessionsForProject({
      threads: [
        { ...thread("old", "/a", at(1)), title: "older" },
        { ...thread("new", "/a", at(5)), title: "newer" },
      ],
      projectId: "/a",
    });
    expect(active.map((session) => session.title)).toEqual(["newer", "older"]);
  });

  it("leaves other projects out", () => {
    const { active } = sessionsForProject({
      threads: [thread("mine", "/a", at(1)), thread("theirs", "/b", at(2))],
      projectId: "/a",
    });
    expect(active.map((session) => session.id)).toEqual(["mine"]);
  });

  it("keeps twenty open and counts the rest as the settled tail", () => {
    // A folder with hundreds of sessions would otherwise bury every other
    // project in the list.
    const shelves = sessionsForProject({ threads: many(53), projectId: "/a" });
    expect(shelves.active).toHaveLength(SIDEBAR_SESSIONS_PER_PROJECT);
    expect(shelves.settledCount).toBe(33);
    // Nothing from the tail renders until the shelf is opened.
    expect(shelves.settled).toHaveLength(0);
  });

  it("reveals the tail a page at a time", () => {
    const page = sessionsForProject({
      threads: many(80),
      projectId: "/a",
      settledVisible: SIDEBAR_SETTLED_PAGE,
    });
    expect(page.settled).toHaveLength(SIDEBAR_SETTLED_PAGE);
    const second = sessionsForProject({
      threads: many(80),
      projectId: "/a",
      settledVisible: SIDEBAR_SETTLED_PAGE * 2,
    });
    expect(second.settled).toHaveLength(SIDEBAR_SETTLED_PAGE * 2);
    // The tail continues exactly where the open list stopped: newest is t79,
    // so the open twenty are t79..t60 and the first settled row is t59.
    expect(page.active.at(-1)?.id).toBe("t60");
    expect(page.settled[0]?.id).toBe("t59");
  });

  it("never pages past the end", () => {
    const shelves = sessionsForProject({
      threads: many(22),
      projectId: "/a",
      settledVisible: 500,
    });
    expect(shelves.settled).toHaveLength(2);
  });

  it("has no shelf when they all fit", () => {
    expect(sessionsForProject({ threads: many(3), projectId: "/a" }).settledCount).toBe(0);
  });

  it("marks a running session so it can be picked out", () => {
    const { active } = sessionsForProject({
      threads: [thread("busy", "/a", at(1), "running"), thread("idle", "/a", at(2))],
      projectId: "/a",
    });
    expect(active.find((session) => session.id === "busy")?.running).toBe(true);
    expect(active.find((session) => session.id === "idle")?.running).toBe(false);
  });

  it("names a session that has no title", () => {
    const { active } = sessionsForProject({
      threads: [{ ...thread("t1", "/a", at(1)), title: "   " }],
      projectId: "/a",
    });
    expect(active[0]?.title).toBe("Untitled");
  });
});

describe("compact time labels", () => {
  it("drop the trailing ago a sidebar row has no width for", () => {
    expect(compactTimeLabel("15m ago")).toBe("15m");
    expect(compactTimeLabel("2d ago")).toBe("2d");
  });

  it("shorten just now", () => {
    expect(compactTimeLabel("just now")).toBe("now");
  });

  it("leave anything else alone", () => {
    expect(compactTimeLabel("Aug 7")).toBe("Aug 7");
  });
});

describe("the active project row", () => {
  const threads = [
    thread("t1", "/a", "2026-08-01T00:00:00.000Z"),
    thread("t2", "/b", "2026-08-01T00:00:00.000Z"),
  ];

  it("is the one the project route names", () => {
    expect(resolveActiveProjectId({ routeProjectId: "/a", threads })).toBe("/a");
  });

  it("follows the open session back to its folder", () => {
    expect(
      resolveActiveProjectId({ routeEnvironmentId: "local", routeThreadId: "t2", threads }),
    ).toBe("/b");
  });

  it("follows a draft to the folder the draft carries", () => {
    // A draft has no server thread yet, so nothing in `threads` can answer it.
    expect(resolveActiveProjectId({ routeDraftProjectId: "/b", threads })).toBe("/b");
  });

  it("does not match a thread id from another environment", () => {
    expect(
      resolveActiveProjectId({ routeEnvironmentId: "remote", routeThreadId: "t2", threads }),
    ).toBeNull();
  });

  it("highlights nothing on a route that names no project", () => {
    expect(resolveActiveProjectId({ threads })).toBeNull();
    expect(resolveActiveProjectId({ routeThreadId: "gone", threads })).toBeNull();
  });
});
