/**
 * Mirror of core's src/brand.ts for this dependency-free package. When
 * renaming the product, update PRODUCT_NAME here and in core/src/brand.ts
 * (and sandbox/src/brand.ts) together — see RENAME.md at the repo root.
 */
export const PRODUCT_NAME = "loop";
export const CONFIG_DIR_NAME = `.${PRODUCT_NAME}`;
export const ENV_PREFIX = PRODUCT_NAME.toUpperCase();

/** Full env-var name for a suffix: envName("TUI_DEBUG") → "LOOP_TUI_DEBUG". */
export function envName(suffix: string): string {
    return `${ENV_PREFIX}_${suffix}`;
}

/** Read a branded env var by suffix. */
export function brandEnv(suffix: string): string | undefined {
    return process.env[envName(suffix)];
}
