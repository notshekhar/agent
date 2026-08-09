import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  MousePointerClick,
  PictureInPicture2,
  RotateCw,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { NO_OMNIBOX_HIGHLIGHT, nextOmniboxHighlight, resolveOmniboxInput } from "./previewOmnibox";
import {
  matchPreviewUrlSuggestions,
  type PreviewUrlHistoryEntry,
  type PreviewUrlSuggestion,
} from "./previewUrlHistory";
import { PreviewUrlSuggestions } from "./PreviewUrlSuggestions";

interface Props {
  url: string;
  displayUrl?: string | undefined;
  loading: boolean;
  loadProgress: number;
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean | undefined;
  /** Bumping this value re-focuses and selects the URL input. */
  focusUrlNonce?: number | undefined;
  /** Visited pages for this environment; drives suggestions and type-ahead. */
  history?: ReadonlyArray<PreviewUrlHistoryEntry> | undefined;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onSubmit: (url: string) => void;
  /** When provided, renders an "Open in browser" affordance to the right. */
  onOpenInBrowser?: (() => void) | undefined;
  onCapture?: ((record: boolean) => void) | undefined;
  captureDisabled?: boolean | undefined;
  recording?: boolean | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  /**
   * When provided, renders an annotation-mode toggle button to the right of
   * the URL input. Pressed while annotation mode is active (button shows in `pressed`
   * state). Disabled in `pickDisabled` mode.
   */
  onPickElement?: (() => void) | undefined;
  pickActive?: boolean | undefined;
  pickDisabled?: boolean | undefined;
  /** Optional reason string surfaced in the disabled tooltip. */
  pickDisabledReason?: string | undefined;
  /**
   * Trailing slot rendered after the URL input. Used by the preview view
   * to mount the three-dot menu (hard reload, devtools, zoom, clear data).
   */
  trailingActions?: ReactNode;
}

const NOOP = () => {};

export function PreviewChromeRow({
  url,
  displayUrl,
  loading,
  loadProgress,
  canGoBack,
  canGoForward,
  refreshDisabled,
  inputDisabled,
  focusUrlNonce,
  history,
  onBack,
  onForward,
  onRefresh,
  onSubmit,
  onOpenInBrowser,
  onCapture,
  captureDisabled,
  recording,
  onPictureInPicture,
  pictureInPicture,
  pictureInPictureDisabled,
  onPickElement,
  pickActive,
  pickDisabled,
  pickDisabledReason,
  trailingActions,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const addressRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);
  // `null` means the bar is showing the current page untouched, so suggestions
  // fall back to recent history the way a browser does on a fresh click.
  const [typed, setTyped] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(NO_OMNIBOX_HIGHLIGHT);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const suggestions = useMemo(
    () => matchPreviewUrlSuggestions(history ?? [], typed ?? "", { exclude: url }),
    [history, typed, url],
  );
  const listOpen = inputFocused && suggestionsOpen && suggestions.length > 0;
  const activeSuggestion = activeIndex >= 0 ? suggestions[activeIndex] : undefined;

  useEffect(() => {
    if (focusUrlNonce == null) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
  }, [focusUrlNonce]);

  // Type-ahead only counts if the guessed remainder is selected, and the input
  // has to be rendered with the completed value before that range exists.
  useEffect(() => {
    const selection = pendingSelectionRef.current;
    if (!selection) return;
    pendingSelectionRef.current = null;
    inputRef.current?.setSelectionRange(selection.start, selection.end);
  });

  const closeSuggestions = () => {
    setSuggestionsOpen(false);
    setActiveIndex(NO_OMNIBOX_HIGHLIGHT);
  };

  const submitUrl = (next: string) => {
    const trimmed = next.trim();
    if (trimmed.length === 0) return;
    closeSuggestions();
    onSubmit(trimmed);
    inputRef.current?.blur();
  };

  const submit = (event?: FormEvent | KeyboardEvent) => {
    event?.preventDefault();
    submitUrl(activeSuggestion?.url ?? draft);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    const target = event.target;
    // Suggestions are recomputed here rather than read from the memo above:
    // that one still reflects the previous keystroke at this point.
    const state = resolveOmniboxInput({
      value,
      inputType: (event.nativeEvent as InputEvent).inputType,
      caretAtEnd: target.selectionStart === value.length,
      suggestions: matchPreviewUrlSuggestions(history ?? [], value, { exclude: url }),
    });
    setTyped(state.typed);
    setDraft(state.value);
    setActiveIndex(NO_OMNIBOX_HIGHLIGHT);
    setSuggestionsOpen(true);
    pendingSelectionRef.current = state.selection;
  };

  const moveHighlight = (direction: 1 | -1) => {
    const index = nextOmniboxHighlight(activeIndex, direction, suggestions.length);
    setActiveIndex(index);
    // Stepping through the list previews each row in the bar, and stepping off
    // the end restores whatever the user had typed.
    setDraft(index === NO_OMNIBOX_HIGHLIGHT ? (typed ?? url) : (suggestions[index]?.typed ?? url));
  };

  return (
    <div className="relative">
      <form onSubmit={submit} className="surface-subheader gap-1 px-2" data-surface-subheader>
        <div className="flex items-center gap-0.5" role="group" aria-label="Navigation">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoBack ? onBack : NOOP}
                  disabled={!canGoBack}
                  aria-label="Back"
                  type="button"
                />
              }
            >
              <ArrowLeft />
            </TooltipTrigger>
            <TooltipPopup>Back</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoForward ? onForward : NOOP}
                  disabled={!canGoForward}
                  aria-label="Forward"
                  type="button"
                />
              }
            >
              <ArrowRight />
            </TooltipTrigger>
            <TooltipPopup>Forward</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={refreshDisabled ? NOOP : onRefresh}
                  disabled={refreshDisabled}
                  aria-label={loading ? "Stop" : "Refresh"}
                  type="button"
                />
              }
            >
              <RotateCw className={cn(loading && "animate-spin")} />
            </TooltipTrigger>
            <TooltipPopup>{loading ? "Loading…" : "Refresh"}</TooltipPopup>
          </Tooltip>
        </div>

        <InputGroup
          ref={addressRef}
          variant="ghost"
          className="group/address h-7 flex-1 rounded-md"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupInput
                  ref={inputRef}
                  value={inputFocused ? draft : (displayUrl ?? url)}
                  className={cn(
                    onOpenInBrowser &&
                      !inputFocused &&
                      "group-hover/address:pe-7 transition-[padding]",
                  )}
                  onChange={handleChange}
                  onFocus={() => {
                    setDraft(url);
                    setTyped(null);
                    setActiveIndex(NO_OMNIBOX_HIGHLIGHT);
                    setSuggestionsOpen(true);
                    setInputFocused(true);
                    queueMicrotask(() => inputRef.current?.select());
                  }}
                  onBlur={() => {
                    setInputFocused(false);
                    closeSuggestions();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      if (suggestions.length === 0) return;
                      event.preventDefault();
                      setSuggestionsOpen(true);
                      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
                      return;
                    }
                    if (event.key === "Enter") submit(event);
                    if (event.key === "Escape") {
                      event.preventDefault();
                      // First Escape dismisses the list and puts back what was
                      // typed; a second one abandons the edit entirely.
                      if (listOpen) {
                        setDraft(typed ?? url);
                        closeSuggestions();
                        return;
                      }
                      setDraft(url);
                      setTyped(null);
                      inputRef.current?.blur();
                    }
                  }}
                  placeholder="Search or enter URL"
                  spellCheck={false}
                  disabled={inputDisabled}
                  data-preview-url-input
                  size="sm"
                  role="combobox"
                  aria-autocomplete="both"
                  aria-expanded={listOpen}
                  aria-controls={listOpen ? listId : undefined}
                  aria-activedescendant={
                    listOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined
                  }
                />
              }
            />
            {!inputFocused && displayUrl ? <TooltipPopup>{url}</TooltipPopup> : null}
          </Tooltip>
          {onOpenInBrowser && !inputFocused ? (
            <InputGroupAddon
              align="inline-end"
              className="pointer-events-none absolute inset-y-0 right-0 opacity-0 transition-opacity group-hover/address:pointer-events-auto group-hover/address:opacity-100"
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={onOpenInBrowser}
                      aria-label="Open in system browser"
                      type="button"
                    />
                  }
                >
                  <ExternalLink />
                </TooltipTrigger>
                <TooltipPopup>Open in system browser</TooltipPopup>
              </Tooltip>
            </InputGroupAddon>
          ) : null}
          {listOpen ? (
            <PreviewUrlSuggestions
              suggestions={suggestions}
              activeIndex={activeIndex}
              anchorRef={addressRef}
              listId={listId}
              optionId={optionId}
              onHighlight={setActiveIndex}
              onSelect={(suggestion: PreviewUrlSuggestion) => submitUrl(suggestion.url)}
            />
          ) : null}
        </InputGroup>

        {onPickElement ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pickActive ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={onPickElement}
                  disabled={pickDisabled}
                  aria-label={pickActive ? "Cancel annotation" : "Annotate preview"}
                  aria-pressed={pickActive ? "true" : "false"}
                  type="button"
                />
              }
            >
              <MousePointerClick className={cn(pickActive && "text-primary")} />
            </TooltipTrigger>
            <TooltipPopup>
              {pickDisabled && pickDisabledReason
                ? pickDisabledReason
                : pickActive
                  ? "Cancel annotation (Esc)"
                  : "Annotate elements, regions, and drawings"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {onCapture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={recording ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={(event) => onCapture(event.shiftKey)}
                  aria-label={recording ? "Stop recording" : "Capture screenshot"}
                  type="button"
                  className="relative"
                  disabled={captureDisabled}
                />
              }
            >
              <Camera className={cn(recording && "text-destructive")} />
              {recording ? (
                <span className="absolute right-0.5 top-0.5 size-1.5 animate-status-pulse rounded-full bg-destructive" />
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              {recording ? "Stop recording" : "Screenshot · Shift-click to record"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {onPictureInPicture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pictureInPicture ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={onPictureInPicture}
                  aria-label={
                    pictureInPicture ? "Close floating preview" : "Float preview over chat"
                  }
                  aria-pressed={pictureInPicture ? "true" : "false"}
                  type="button"
                  disabled={pictureInPictureDisabled}
                />
              }
            >
              <PictureInPicture2 className={cn(pictureInPicture && "text-primary")} />
            </TooltipTrigger>
            <TooltipPopup>
              {pictureInPicture ? "Close floating preview" : "Float preview over chat"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {trailingActions}
      </form>
      {loadProgress > 0 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 rounded-r-full bg-primary transition-all duration-150 ease-out"
          style={{
            width: `${loadProgress}%`,
            boxShadow: "0 0 6px 1px var(--color-ring)",
          }}
        />
      ) : null}
    </div>
  );
}
