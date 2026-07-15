export class RpcClient {
    #socket: WebSocket | null = null;
    #nextID = 1;
    #pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
    #reconnectDelay = 500;
    #connected = false;

    constructor(
        private readonly callbacks: {
            onOpen(): void;
            onClose(): void;
            onEvent(event: unknown): void;
        },
        private readonly token = new URLSearchParams(location.search).get("token") || "",
    ) {}

    get connected(): boolean {
        return this.#connected;
    }

    connect(): void {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        this.#socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(this.token)}`);
        this.#socket.onopen = () => {
            this.#connected = true;
            this.#reconnectDelay = 500;
            this.callbacks.onOpen();
        };
        this.#socket.onmessage = (event) => this.#receive(event.data);
        this.#socket.onclose = () => this.#disconnect();
    }

    request(method: string, params?: unknown, timeoutMs = 30_000): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.#connected || !this.#socket) return reject(new Error("not connected"));
            const id = this.#nextID++;
            const timer = setTimeout(() => {
                if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
            }, timeoutMs);
            this.#pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    }

    #receive(raw: string): void {
        let message: any;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        if (message.id !== undefined && this.#pending.has(message.id)) {
            const pending = this.#pending.get(message.id)!;
            this.#pending.delete(message.id);
            message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
            return;
        }
        if (message.method === "session.event") this.callbacks.onEvent(message.params);
    }

    #disconnect(): void {
        this.#connected = false;
        for (const { reject } of this.#pending.values()) reject(new Error("connection closed"));
        this.#pending.clear();
        this.callbacks.onClose();
        setTimeout(() => this.connect(), this.#reconnectDelay);
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 10_000);
    }
}
