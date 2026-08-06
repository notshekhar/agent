/**
 * loop's settings, read and written over loop's own JSON-RPC.
 *
 * Nothing here is hardcoded, and that is the point: the rows come from loop's
 * `settings.list` — a loop-side allowlist carrying its own labels and
 * descriptions — so adding a setting to loop makes it appear in this app with
 * no edit here. The same goes for extensions via `extension.list`.
 *
 * This deliberately does NOT go through the effect-RPC handler layer. That
 * layer exists to serve the vendored UI's own contract; settings are loop's
 * concept with no counterpart in it, so pretending otherwise would mean
 * inventing a shape and then translating back.
 */
import { useCallback, useEffect, useState } from "react";

import { loopCall } from "../../loop/transport";

/** One boolean setting loop is willing to expose. */
export interface LoopSetting {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly value: boolean;
}

export interface LoopExtension {
  readonly name: string;
  readonly enabled: boolean;
  readonly builtin?: boolean;
  readonly description?: string;
  readonly version?: string;
}

export interface LoopSettingsState {
  readonly settings: readonly LoopSetting[];
  readonly extensions: readonly LoopExtension[];
  readonly loading: boolean;
  /** Set when loop could not be reached; the panel says so rather than lying. */
  readonly error: string | null;
  readonly setSetting: (key: string, value: boolean) => Promise<void>;
  readonly setExtensionEnabled: (name: string, value: boolean) => Promise<void>;
  readonly reload: () => void;
}

export function useLoopSettings(): LoopSettingsState {
  const [settings, setSettings] = useState<readonly LoopSetting[]>([]);
  const [extensions, setExtensions] = useState<readonly LoopExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      loopCall<readonly LoopSetting[]>("settings.list"),
      loopCall<readonly LoopExtension[]>("extension.list").catch(() => []),
    ])
      .then(([nextSettings, nextExtensions]) => {
        if (cancelled) return;
        setSettings(nextSettings);
        setExtensions(nextExtensions);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [generation]);

  // Applied locally first so a toggle does not wait on a round trip, then
  // rolled back if loop rejects it — the switch must never end up showing a
  // value loop did not accept.
  const setSetting = useCallback(async (key: string, value: boolean) => {
    setSettings((current) =>
      current.map((setting) => (setting.key === key ? { ...setting, value } : setting)),
    );
    try {
      await loopCall("settings.set", { key, value });
    } catch (cause) {
      setSettings((current) =>
        current.map((setting) => (setting.key === key ? { ...setting, value: !value } : setting)),
      );
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const setExtensionEnabled = useCallback(async (name: string, value: boolean) => {
    setExtensions((current) =>
      current.map((extension) => (extension.name === name ? { ...extension, enabled: value } : extension)),
    );
    try {
      await loopCall("extension.setEnabled", { name, value });
    } catch (cause) {
      setExtensions((current) =>
        current.map((extension) =>
          extension.name === name ? { ...extension, enabled: !value } : extension,
        ),
      );
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  return { settings, extensions, loading, error, setSetting, setExtensionEnabled, reload };
}
