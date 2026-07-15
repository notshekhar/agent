/** Mutable app state shared across features. A single exported object so
 * every module observes the same values without getter/setter ceremony. */

export interface OpenSession {
    /** null while the draft has not been persisted yet. */
    id: string | null;
    model: string;
    name: string | null;
    cwd: string;
    /** opencode flow: drafts only hit the DB on the first prompt. */
    draft: boolean;
}

export const state = {
    serverInfo: null as any,
    catalog: [] as any[],
    authProviders: [] as string[],
    sessions: [] as any[],
    /** cwd string, or null = all projects */
    selectedProject: null as string | null,
    /** the open session — null on the home screen */
    current: null as OpenSession | null,
    selectedModel: "",
    running: false,
    /** last session.event seq seen for `current` (reconnect catch-up) */
    lastSeq: 0,
};
