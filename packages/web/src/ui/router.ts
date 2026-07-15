/** URL routing: real /session/<id> paths so reload and back/forward restore
 * the open session. */

export function routedSessionId(): string | null {
    const m = location.pathname.match(/^\/session\/([A-Za-z0-9]+)$/);
    if (m) return m[1]!;
    // Legacy deep links: earlier builds used #s=<id>.
    const h = location.hash.match(/^#s=([A-Za-z0-9]+)/);
    return h ? h[1]! : null;
}

export function setRoute(id: string | null): void {
    const want = id ? "/session/" + id : "/";
    if (location.pathname === want && !location.hash) return;
    // The server serves the app for /session/<id> too; the token query
    // string must survive every navigation.
    history.pushState(null, "", want + location.search);
}
