/**
 * models.dev's "vercel" (AI Gateway) listing mirrors the gateway's whole
 * marketplace — embeddings, rerankers, transcription, and image/video/speech
 * generators sit alongside the chat models. Every other catalog provider is
 * chat-only, so this filter is applied to vercel entries alone (both in the
 * build-time generator and the runtime models.dev fetch).
 *
 * Media generators declare a non-text output modality and are dropped on that
 * alone; embeddings/rerankers/transcribers claim text output on models.dev, so
 * those fall to the id pattern.
 */
const NON_CHAT_ID = /embed|rerank|whisper|transcrib|realtime/i;

export function isVercelChatModel(rawId: string, outputModalities: string[] | undefined): boolean {
    return (outputModalities ?? ["text"]).includes("text") && !NON_CHAT_ID.test(rawId);
}
