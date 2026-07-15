import { byId } from "../lib/dom";
import { state } from "../state";

export function setStatus(text: string): void {
    byId("status").textContent = text;
}

export function setRunning(running: boolean): void {
    state.running = running;
    byId("stop").classList.toggle("visible", running);
    byId<HTMLButtonElement>("send").disabled = running;
    if (!running) setStatus("");
}
