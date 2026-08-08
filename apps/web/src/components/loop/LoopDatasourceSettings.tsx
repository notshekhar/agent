/**
 * The GUI form of the terminal's `/datasource` panel.
 *
 * Connections live in loop (`~/.loop/datasources.json`) and are read by the
 * agent's `sql` tool, so everything saved here is immediately usable from a
 * chat — this panel adds no store of its own.
 *
 * Secrets are deliberately one-way: a password can be written but is never
 * read back (`datasource.list` withholds it), because `loop serve` is
 * reachable over a network. The form shows whether one is set rather than what
 * it is, and leaving the field untouched keeps it.
 */
import { useCallback, useEffect, useState } from "react";

import {
  DATASOURCE_TYPES,
  DEFAULT_PORT,
  type DataSource,
  type DataSourceConfig,
  type DataSourceType,
  readDatasources,
  removeDatasource,
  saveDatasource,
  testDatasource,
} from "../../loop/datasources.ts";
import { cn } from "../../lib/utils";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

interface Draft {
  id: string;
  type: DataSourceType;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  /** Whether the password field was edited — an untouched one is not sent. */
  passwordTouched: boolean;
  ssl: boolean;
}

const EMPTY_DRAFT: Draft = {
  id: "",
  type: "postgres",
  host: "",
  port: "",
  database: "",
  user: "",
  password: "",
  passwordTouched: false,
  ssl: false,
};

function draftOf(source: DataSource): Draft {
  return {
    id: source.id,
    type: source.config.type,
    host: source.config.host,
    port: String(source.config.port),
    database: source.config.database,
    user: source.config.user,
    // Only ever an env reference; a real secret never arrives here.
    password: source.passwordIsEnvRef ? (source.config.password ?? "") : "",
    passwordTouched: false,
    ssl: source.config.ssl === true,
  };
}

/**
 * The wire shape of a draft.
 *
 * `password` is omitted unless the field was actually edited — that omission is
 * what tells loop to keep the stored secret rather than clear it.
 */
function configOf(draft: Draft): Partial<DataSourceConfig> {
  return {
    type: draft.type,
    host: draft.host.trim(),
    port: Number(draft.port.trim() || DEFAULT_PORT[draft.type]),
    database: draft.database.trim(),
    user: draft.user.trim(),
    ...(draft.passwordTouched ? { password: draft.password } : {}),
    ...(draft.ssl ? { ssl: true } : {}),
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground/70">{hint}</p> : null}
    </div>
  );
}

export function LoopDatasourceSettings() {
  const [sources, setSources] = useState<readonly DataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The id being edited, or "" for a new one — null when the form is closed. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ id: string; ok: boolean; error?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setSources(await readDatasources());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const closeForm = useCallback(() => {
    setDraft(null);
    setEditingId(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await load();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const save = useCallback(async () => {
    if (!draft) return;
    const ok = await run(() => saveDatasource(draft.id.trim(), configOf(draft)));
    if (ok) closeForm();
  }, [draft, run, closeForm]);

  /**
   * Test what is on screen, not what is saved.
   *
   * The draft is sent so unsaved credentials can be proven before committing;
   * the id rides along so loop can fall back to the stored password when the
   * field was left untouched.
   */
  const test = useCallback(
    async (id: string, config?: Partial<DataSourceConfig>) => {
      setBusy(true);
      setProbe(null);
      setError(null);
      try {
        const result = await testDatasource(id, config);
        setProbe({ id, ok: result.ok, ...(result.error ? { error: result.error } : {}) });
      } catch (err) {
        setProbe({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const remove = useCallback(
    (id: string) => {
      if (!window.confirm(`Remove the "${id}" connection? The agent will lose access to it.`)) {
        return;
      }
      void run(() => removeDatasource(id));
    },
    [run],
  );

  const startAdd = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setEditingId("");
    setProbe(null);
  }, []);

  const startEdit = useCallback((source: DataSource) => {
    setDraft(draftOf(source));
    setEditingId(source.id);
    setProbe(null);
  }, []);

  const canSave =
    draft !== null &&
    draft.id.trim() !== "" &&
    draft.host.trim() !== "" &&
    draft.database.trim() !== "" &&
    draft.user.trim() !== "";

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Database connections"
        headerAction={
          draft === null ? (
            <Button size="sm" variant="outline" onClick={startAdd}>
              Add connection
            </Button>
          ) : null
        }
      >
        <p className="px-3 pb-2 text-xs text-muted-foreground sm:px-4">
          Saved connections are available to the agent through its <code>sql</code> tool, which
          runs read-only queries. Same store as the terminal&apos;s <code>/datasource</code> panel.
        </p>

        {error ? (
          <div className="mx-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:mx-4">
            {error}
          </div>
        ) : null}

        {loading ? (
          <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">Loading…</p>
        ) : sources.length === 0 && draft === null ? (
          <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
            No connections yet. Add one to let the agent query your database.
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          {sources.map((source) => (
            <div
              key={source.id}
              className="mx-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5 sm:mx-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{source.id}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {source.config.type}
                    </span>
                    {source.config.ssl ? (
                      <span className="text-[10px] text-muted-foreground">SSL</span>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {source.config.user}@{source.config.host}:{source.config.port}/
                    {source.config.database}
                    {source.hasPassword ? "" : " · no password"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void test(source.id)}
                  >
                    Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => startEdit(source)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => remove(source.id)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              {probe?.id === source.id ? (
                <p
                  className={cn(
                    "mt-1.5 text-xs",
                    probe.ok ? "text-success" : "text-destructive",
                  )}
                >
                  {probe.ok ? "Connected." : `Failed: ${probe.error}`}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        {draft ? (
          <div className="mx-3 mt-2 rounded-lg border border-border bg-card/60 p-4 sm:mx-4">
            <h3 className="mb-3 text-sm font-medium">
              {editingId ? `Edit "${editingId}"` : "New connection"}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" hint="Referenced by the agent, e.g. warehouse">
                <Input
                  value={draft.id}
                  disabled={Boolean(editingId)}
                  placeholder="warehouse"
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              </Field>
              <Field label="Engine">
                <select
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={draft.type}
                  onChange={(e) => {
                    const type = e.target.value as DataSourceType;
                    // The port follows the engine while it is still the old
                    // engine's default, so switching does not leave 5432 on a
                    // MySQL connection — but a typed port is never overwritten.
                    const wasDefault =
                      draft.port === "" || draft.port === String(DEFAULT_PORT[draft.type]);
                    setDraft({
                      ...draft,
                      type,
                      port: wasDefault ? String(DEFAULT_PORT[type]) : draft.port,
                    });
                  }}
                >
                  {DATASOURCE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Host">
                <Input
                  value={draft.host}
                  placeholder="db.internal"
                  onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                />
              </Field>
              <Field label="Port" hint={`Default ${DEFAULT_PORT[draft.type]}`}>
                <Input
                  value={draft.port}
                  inputMode="numeric"
                  placeholder={String(DEFAULT_PORT[draft.type])}
                  onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                />
              </Field>
              <Field label="Database">
                <Input
                  value={draft.database}
                  placeholder="analytics"
                  onChange={(e) => setDraft({ ...draft, database: e.target.value })}
                />
              </Field>
              <Field label="User">
                <Input
                  value={draft.user}
                  placeholder="reader"
                  onChange={(e) => setDraft({ ...draft, user: e.target.value })}
                />
              </Field>
              <Field
                label="Password"
                hint={
                  editingId && !draft.passwordTouched
                    ? "Stored — leave blank to keep it. Use ${env:VAR} to read from the environment."
                    : "Use ${env:VAR} to read from the environment instead of storing it."
                }
              >
                <Input
                  type={draft.password.startsWith("${env:") ? "text" : "password"}
                  value={draft.password}
                  placeholder={editingId ? "unchanged" : "${env:PGPASSWORD}"}
                  onChange={(e) =>
                    setDraft({ ...draft, password: e.target.value, passwordTouched: true })
                  }
                />
              </Field>
              <Field label="SSL" hint="Recommended for anything remote">
                <div className="flex h-9 items-center">
                  <Switch
                    checked={draft.ssl}
                    onCheckedChange={(ssl) => setDraft({ ...draft, ssl })}
                  />
                </div>
              </Field>
            </div>

            {probe && probe.id === (editingId || draft.id.trim()) ? (
              <p className={cn("mt-3 text-xs", probe.ok ? "text-success" : "text-destructive")}>
                {probe.ok ? "Connected." : `Failed: ${probe.error}`}
              </p>
            ) : null}

            <div className="mt-4 flex items-center gap-2">
              <Button size="sm" disabled={!canSave || busy} onClick={() => void save()}>
                {editingId ? "Save" : "Add"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canSave || busy}
                onClick={() => void test(editingId || draft.id.trim(), configOf(draft))}
              >
                Test connection
              </Button>
              <Button size="sm" variant="ghost" onClick={closeForm}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
