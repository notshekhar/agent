/**
 * The two long runs of plain bindings that used to open `ChatViewContent`.
 *
 * Neither run reads anything from the component: one binds atom commands, the
 * other pulls stable action functions off the composer draft store, and both
 * were ~35 hook calls of pure preamble before the first line of actual logic.
 * They are hooks rather than constants because that is what `useAtomCommand`
 * and the store selector are, so each has to keep its place in the call order —
 * which is exactly why they are one hook each, called where the run was.
 */
import { useComposerDraftStore } from "../composerDraftStore";
import { previewEnvironment } from "../state/preview";
import { projectEnvironment } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";

/**
 * Every environment command the chat view issues.
 *
 * `reportFailure: false` on most of them is deliberate: the view surfaces those
 * failures itself, inline against the thread that caused them.
 */
export function useChatViewCommands() {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const switchGitRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToThreadApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const revertThreadCheckpoint = useAtomCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  return {
    updateProject,
    upsertKeybinding,
    openTerminal,
    writeTerminal,
    closeTerminalMutation,
    createThread,
    deleteThread,
    updateThreadMetadata,
    switchGitRef,
    setThreadRuntimeMode,
    setThreadInteractionMode,
    startThreadTurn,
    interruptThreadTurn,
    respondToThreadApproval,
    respondToThreadUserInput,
    revertThreadCheckpoint,
    openPreview,
    closePreview,
  };
}

/**
 * The composer draft store's action functions. These are stable across
 * renders — selecting each one individually is how the store is meant to be
 * read, and it keeps a draft's *state* (which does change) out of here.
 */
export function useComposerDraftActions() {
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftElementContexts = useComposerDraftStore(
    (store) => store.setElementContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  return {
    setComposerDraftPrompt,
    addComposerDraftImages,
    setComposerDraftTerminalContexts,
    setComposerDraftElementContexts,
    setComposerDraftPreviewAnnotations,
    setComposerDraftReviewComments,
    setComposerDraftModelSelection,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    clearComposerDraftContent,
    setDraftThreadContext,
    getDraftSessionByLogicalProjectKey,
    getDraftSession,
    setLogicalProjectDraftThreadId,
  };
}
