/**
 * Pane-level agent status — one source of truth for "what is the agent doing
 * right now": working (a turn / compaction / hook command is running),
 * blocked (an agent-driven prompt is waiting on the user), or idle. The two
 * UI authorities that already know feed it: the working indicator (every
 * working stretch goes through showWorking/hideWorking) and showSelector
 * (every modal prompt steals the editor through it). Only agent-driven
 * prompts — ask tool, bash/path/plan approvals — count as blocked; menus the
 * user opened themselves (/settings, pickers) are not the agent waiting
 * (Claude-in-herdr parity: herdr's claude manifest skips its own menus too).
 *
 * Consumers subscribe for semantic transitions instead of re-wiring the TUI:
 * the herdr reporter, the Notification hook bridge, and any future watcher
 * (terminal title, other multiplexers).
 *
 * Transitions upward in urgency (idle → working → blocked) emit immediately;
 * downward transitions settle for a beat first, so the seams' natural
 * flicker — back-to-back queued turns, an ask flow re-opening a selector per
 * question — never reaches consumers.
 */

export type AgentStatus = "idle" | "working" | "blocked";

export interface AgentStatusEvent {
    status: AgentStatus;
    /** What the agent is blocked on ("question", "bash approval", …). */
    label?: string;
}

export type AgentStatusListener = (e: AgentStatusEvent) => void;

const RANK: Record<AgentStatus, number> = { idle: 0, working: 1, blocked: 2 };

export interface AgentStatusBus {
    /** Working-indicator authority: a working stretch started/ended. */
    setWorking(): void;
    setIdle(): void;
    /** An agent-driven prompt opened; returns its closer. Nested prompts stack. */
    modalOpened(label: string): () => void;
    current(): AgentStatusEvent;
    on(listener: AgentStatusListener): void;
}

export function createAgentStatusBus(settleMs = 250): AgentStatusBus {
    let working = false;
    let modalDepth = 0;
    let modalLabel: string | undefined;
    let published: AgentStatusEvent = { status: "idle" };
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners = new Set<AgentStatusListener>();

    const desired = (): AgentStatusEvent =>
        modalDepth > 0
            ? { status: "blocked", label: modalLabel }
            : working
              ? { status: "working" }
              : { status: "idle" };

    function emit(): void {
        const next = desired();
        if (next.status === published.status && next.label === published.label) return;
        published = next;
        for (const l of listeners) {
            // Consumer bugs must not break the UI seams that call into here.
            try {
                l(next);
            } catch {}
        }
    }

    function publish(): void {
        if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = undefined;
        }
        if (RANK[desired().status] >= RANK[published.status]) {
            emit();
            return;
        }
        settleTimer = setTimeout(() => {
            settleTimer = undefined;
            emit();
        }, settleMs);
        settleTimer.unref?.();
    }

    return {
        setWorking() {
            working = true;
            publish();
        },
        setIdle() {
            working = false;
            publish();
        },
        modalOpened(label: string) {
            modalDepth += 1;
            modalLabel = label;
            publish();
            let closed = false;
            return () => {
                if (closed) return;
                closed = true;
                modalDepth = Math.max(0, modalDepth - 1);
                if (modalDepth === 0) modalLabel = undefined;
                publish();
            };
        },
        current: () => published,
        on(listener: AgentStatusListener) {
            listeners.add(listener);
        },
    };
}
