import type { EnvironmentId } from "@loop/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectPreviewUrlHistory, usePreviewUrlHistoryStore } from "./previewUrlHistoryStore";

const envA = "env-1" as EnvironmentId;
const envB = "env-2" as EnvironmentId;

const historyFor = (environmentId: EnvironmentId) =>
  selectPreviewUrlHistory(usePreviewUrlHistoryStore.getState().byEnvironmentId, environmentId);

beforeEach(() => {
  usePreviewUrlHistoryStore.setState({ byEnvironmentId: {} });
});

describe("previewUrlHistoryStore", () => {
  it("keeps one project's pages out of another's suggestions", () => {
    usePreviewUrlHistoryStore
      .getState()
      .recordVisit(envA, { url: "http://localhost:3000/", title: "A", at: 1 });
    usePreviewUrlHistoryStore
      .getState()
      .recordVisit(envB, { url: "http://localhost:4000/", title: "B", at: 2 });

    expect(historyFor(envA).map((entry) => entry.url)).toEqual(["http://localhost:3000/"]);
    expect(historyFor(envB).map((entry) => entry.url)).toEqual(["http://localhost:4000/"]);
  });

  it("counts a revisit instead of duplicating the row", () => {
    const { recordVisit } = usePreviewUrlHistoryStore.getState();
    recordVisit(envA, { url: "http://localhost:3000/", title: "Home", at: 1 });
    recordVisit(envA, { url: "http://localhost:3000/", title: "Home", at: 5 });

    expect(historyFor(envA)).toHaveLength(1);
    expect(historyFor(envA)[0]).toMatchObject({ visits: 2, lastVisitedAt: 5 });
  });

  it("ignores a page that never got a real URL", () => {
    usePreviewUrlHistoryStore.getState().recordVisit(envA, { url: "about:blank", at: 1 });

    expect(usePreviewUrlHistoryStore.getState().byEnvironmentId).toEqual({});
  });

  it("forgets an environment on request", () => {
    const { recordVisit } = usePreviewUrlHistoryStore.getState();
    recordVisit(envA, { url: "http://localhost:3000/", at: 1 });
    usePreviewUrlHistoryStore.getState().clearEnvironment(envA);

    expect(historyFor(envA)).toEqual([]);
  });

  it("has no history for an environment that has not been visited", () => {
    expect(selectPreviewUrlHistory({}, null)).toEqual([]);
    expect(historyFor(envA)).toEqual([]);
  });
});
