/** The app's single attachments store, shared by the composer (attach),
 * the transcript (clear on re-render), and send (read + reset). */
import { createAttachments } from "./attachments";

export const { attachments, attach, clear } = createAttachments();
