import { describe, expect, it } from "vite-plus/test";

import {
  agentDescriptors,
  effortDescriptors,
  serverConfigFingerprint,
  toProviders,
} from "./serverConfig.ts";

/**
 * The config is polled, so the fingerprint decides what counts as news. Too
 * loose and every atom hanging off the config churns on a timer; too tight and
 * a provider authenticated in the terminal never reaches the app — which is
 * exactly how the list came to be frozen at connect time.
 */
const config = (providers: unknown[], selection: unknown = { instanceId: "kimi", model: "kimi/k3" }) => ({
  providers,
  settings: { textGenerationModelSelection: selection },
});

describe("what counts as an environment change", () => {
  const provider = (instanceId: string, status: string, models = 1) => ({
    instanceId,
    status,
    models: Array.from({ length: models }, (_, index) => ({ slug: `${instanceId}/m${index}` })),
  });

  it("is stable when nothing moved", () => {
    const a = config([provider("kimi", "ready")]);
    const b = config([provider("kimi", "ready")]);
    expect(serverConfigFingerprint(a)).toBe(serverConfigFingerprint(b));
  });

  it("notices a provider becoming authenticated", () => {
    expect(serverConfigFingerprint(config([provider("xai", "disabled")]))).not.toBe(
      serverConfigFingerprint(config([provider("xai", "ready")])),
    );
  });

  it("notices a provider appearing", () => {
    expect(serverConfigFingerprint(config([provider("kimi", "ready")]))).not.toBe(
      serverConfigFingerprint(config([provider("kimi", "ready"), provider("xai", "ready")])),
    );
  });

  it("notices a provider's models changing", () => {
    expect(serverConfigFingerprint(config([provider("kimi", "ready", 1)]))).not.toBe(
      serverConfigFingerprint(config([provider("kimi", "ready", 4)])),
    );
  });

  it("notices the default model changing", () => {
    expect(serverConfigFingerprint(config([provider("kimi", "ready")]))).not.toBe(
      serverConfigFingerprint(
        config([provider("kimi", "ready")], { instanceId: "xai", model: "xai/composer-2.5" }),
      ),
    );
  });

  it("notices the thinking level changing", () => {
    const withThinking = (level: string) =>
      config([
        {
          instanceId: "anthropic",
          status: "ready",
          models: [
            { slug: "anthropic/opus", capabilities: { optionDescriptors: effortDescriptors(reasoningModel, level) } },
          ],
        },
      ]);
    expect(serverConfigFingerprint(withThinking("off"))).not.toBe(
      serverConfigFingerprint(withThinking("high")),
    );
  });

  it("survives a config it cannot read", () => {
    expect(serverConfigFingerprint(null)).toBe("");
    expect(serverConfigFingerprint({})).toBe(JSON.stringify([[], null, null, null]));
  });
});

/**
 * The composer's TraitsPicker draws entirely from `optionDescriptors` and
 * renders nothing when a model declares none — which is why loop had no
 * effort control at all. `dispatch.ts` `thinkingLevelOf` is the other half:
 * it turns the selection back into `session.send`'s `thinking`.
 */
const reasoningModel = { id: "anthropic/opus", provider: "anthropic", reasoning: true };

describe("the effort control loop offers", () => {
  it("offers loop's six thinking levels on a reasoning model", () => {
    const [descriptor] = effortDescriptors(reasoningModel, "off") as {
      id: string;
      type: string;
      options: { id: string }[];
    }[];
    expect(descriptor?.id).toBe("reasoningEffort");
    expect(descriptor?.type).toBe("select");
    expect(descriptor?.options.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("starts on loop's own thinking level, so an untouched picker changes nothing", () => {
    const [descriptor] = effortDescriptors(reasoningModel, "medium") as { currentValue: string }[];
    expect(descriptor?.currentValue).toBe("medium");
  });

  it("offers nothing on a model that cannot reason", () => {
    // The terminal answers "current model does not support thinking" rather
    // than offering levels the provider would ignore.
    expect(effortDescriptors({ id: "xai/composer-2.5", provider: "xai" }, "high")).toEqual([]);
    expect(
      effortDescriptors({ id: "xai/grok-3", provider: "xai", reasoning: false }, "high"),
    ).toEqual([]);
  });
});

/**
 * The agent control has to be a DESCRIPTOR, not merely a stored selection.
 *
 * `composerProviderState` rebuilds a turn's options with
 * `buildProviderOptionSelectionsFromDescriptors`, which walks the descriptors —
 * so an option no model declares is dropped on send. That is exactly what
 * happened to the agent: the composer showed `plan`, `session.send` went out
 * with no `agent` at all, and the picker fell back to `default` the moment the
 * draft became a thread. Planning silently ran as the normal persona.
 */
describe("the agent control loop offers", () => {
  const ids = (descriptors: readonly unknown[]) =>
    (descriptors as { options: { id: string; isDefault?: boolean }[] }[])[0]?.options;

  it("declares an agent descriptor so the choice survives dispatch", () => {
    const [descriptor] = agentDescriptors(["default", "plan", "review"]) as {
      id: string;
      type: string;
    }[];
    expect(descriptor?.id).toBe("agent");
    expect(descriptor?.type).toBe("select");
    expect(ids(agentDescriptors(["default", "plan", "review"]))?.map((o) => o.id)).toEqual([
      "default",
      "plan",
      "review",
    ]);
  });

  it("marks the built-in persona as the default, so the wire can omit it", () => {
    const options = ids(agentDescriptors(["default", "plan"]));
    expect(options?.find((option) => option.isDefault)?.id).toBe("default");
    expect(options?.filter((option) => option.isDefault)).toHaveLength(1);
  });

  it("offers nothing when there is only one agent to choose from", () => {
    expect(agentDescriptors(["default"])).toEqual([]);
    expect(agentDescriptors([])).toEqual([]);
  });

  it("notices an agent being created in the terminal", () => {
    const withAgents = (agents: string[]) =>
      config([
        {
          instanceId: "xai",
          status: "ready",
          models: [{ slug: "xai/grok-4", capabilities: { optionDescriptors: agentDescriptors(agents) } }],
        },
      ]);
    expect(serverConfigFingerprint(withAgents(["default", "plan"]))).not.toBe(
      serverConfigFingerprint(withAgents(["default", "plan", "reviewer"])),
    );
  });
});

/**
 * MEASURED against a live `loop rpc`: `auth.status` answers
 * `providers: ["kimi", "custom:pronto-gpt"]` with
 * `authorized: ["kimi"]` — a custom gateway carries its credential in its own
 * config, so it is never in the auth store's list. Reading readiness off
 * `authorized` marked every gateway "disabled", and the composer's picker
 * drops a non-ready instance's models, so the gateway was visible and
 * unpickable.
 */
describe("which providers a turn can start on", () => {
  const model = (provider: string, id: string) => ({ id, provider });
  const providerAt = (providers: readonly unknown[], instanceId: string) =>
    providers.find(
      (entry) => (entry as { instanceId: string }).instanceId === instanceId,
    ) as { status: string; models: unknown[] } | undefined;

  const built = (auth: { providers?: string[]; authorized?: string[] }) =>
    toProviders(
      [model("kimi", "kimi/k3"), model("custom:pronto-gpt", "custom:pronto-gpt/gpt-5.6-luna")],
      auth,
      null,
      "2026-08-09T00:00:00.000Z",
      "off",
      [],
    );

  it("marks a custom gateway ready even though it holds no auth-store entry", () => {
    const providers = built({
      providers: ["kimi", "custom:pronto-gpt"],
      authorized: ["kimi"],
    });
    expect(providerAt(providers, "custom__pronto-gpt")?.status).toBe("ready");
    expect(providerAt(providers, "custom__pronto-gpt")?.models).toHaveLength(1);
  });

  it("still marks a provider with no credential anywhere as disabled", () => {
    const providers = built({ providers: ["kimi"], authorized: ["kimi"] });
    expect(providerAt(providers, "custom__pronto-gpt")?.status).toBe("disabled");
    expect(providerAt(providers, "kimi")?.status).toBe("ready");
  });
});
