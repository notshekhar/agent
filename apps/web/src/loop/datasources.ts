/**
 * Saved database connections, as the desktop reads and writes them.
 *
 * The connections themselves are loop's — `~/.loop/datasources.json`, the same
 * file the terminal's `/datasource` panel edits and the agent's `sql` tool
 * reads. This is only the RPC-shaped view of them, so both surfaces stay one
 * store rather than two that drift.
 */
import { loopCall } from "./transport.ts";

export type DataSourceType = "postgres" | "mysql" | "redshift";

export interface DataSourceConfig {
  readonly type: DataSourceType;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** Only ever a `${env:VAR}` reference — a real secret never leaves loop. */
  readonly password?: string;
  readonly ssl?: boolean;
}

export interface DataSource {
  readonly id: string;
  readonly config: DataSourceConfig;
  /** Whether a password is stored, since the value itself is withheld. */
  readonly hasPassword: boolean;
  /** True when what is stored is a `${env:VAR}` pointer rather than a secret. */
  readonly passwordIsEnvRef: boolean;
}

export interface TestResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Default port per engine — mirrors the server's own table. */
export const DEFAULT_PORT: Record<DataSourceType, number> = {
  postgres: 5432,
  mysql: 3306,
  redshift: 5439,
};

export const DATASOURCE_TYPES: readonly DataSourceType[] = ["postgres", "mysql", "redshift"];

export async function readDatasources(): Promise<readonly DataSource[]> {
  const result = await loopCall<readonly DataSource[]>("datasource.list", {});
  return Array.isArray(result) ? result : [];
}

/**
 * Create or update a connection.
 *
 * Omitting `password` KEEPS whatever is stored — the list never returns a
 * secret, so an edit form has none to send back, and treating that silence as
 * a clear would break the connection every time someone fixed a port. Passing
 * an empty string is how a password is actually removed.
 */
export async function saveDatasource(id: string, config: Partial<DataSourceConfig>): Promise<void> {
  await loopCall("datasource.save", { id, config });
}

export async function removeDatasource(id: string): Promise<boolean> {
  const result = await loopCall<{ ok?: boolean }>("datasource.remove", { id });
  return result?.ok === true;
}

/**
 * Probe a connection without saving it.
 *
 * `config` is the form's current contents, so a connection can be proven before
 * it is committed; `id` lets the server fall back to the stored password the
 * form was never given.
 */
export async function testDatasource(
  id: string,
  config?: Partial<DataSourceConfig>,
): Promise<TestResult> {
  const result = await loopCall<TestResult>(
    "datasource.test",
    config === undefined ? { id } : { id, config },
  );
  return result ?? { ok: false, error: "no response from loop" };
}
