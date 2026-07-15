/** Minimal DOM boundary: browser features should not spread ID lookups around. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.getElementById(id) as T | null;
    if (!element) throw new Error(`Missing required element #${id}`);
    return element;
}
