export { Session, extractMessageText, generateEntryId, type SessionTreeNode } from "./session";
export { SessionManager, type SessionInfo, type NewSessionOptions } from "./manager";
export { adaptSessionEntry } from "./session-adapter";
export { wrapSessionHookContext, matchSessionHookContext, stripSessionHookContext } from "./hook-context";
export { getDb, closeDb, setDbPathForTests } from "./db";
export { SessionStore, getSessionStore, type SessionRecord } from "./sqlite-store";
export { normalizeUsage, type NormalizedUsage } from "./usage";
export { sessionToMarkdown } from "./export-markdown";
export { migrateLegacySessions, importSessionFile, parseSessionFile, legacySessionsRoot } from "./migrate";
export {
    addLedgerRow,
    attachLedgerEntry,
    auditLedger,
    getCostBaseline,
    migrateCostLedger,
    sumLedgerForSession,
    type LedgerAudit,
    type LedgerSource,
} from "./cost-ledger";
// getProjectModel/setProjectModel/getProjectProviderModel are exported via
// the auth barrel only — exporting them here too would collide in the
// package root's star exports and silently drop the names.
export { migrateProjectStores } from "./projects";
