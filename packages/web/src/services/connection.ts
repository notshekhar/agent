import { RpcClient } from "./rpc-client";

export const token = new URLSearchParams(location.search).get("token") || "";

/** Late-bound callbacks: the entry point assigns these after all features
 * are loaded, so feature modules can import the client without cycles. */
export const handlers = {
    onOpen(): void {},
    onClose(): void {},
    onEvent(_event: unknown): void {},
};

export const client = new RpcClient(
    {
        onOpen: () => handlers.onOpen(),
        onClose: () => handlers.onClose(),
        onEvent: (event) => handlers.onEvent(event),
    },
    token,
);

export const rpc = client.request.bind(client);
