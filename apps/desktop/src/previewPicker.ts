/**
 * Element picking for the preview panel ("Annotate").
 *
 * The renderer has always had the whole downstream half of this — the picked
 * element becomes a composer chip, a `<preview_annotation>` prompt block and a
 * screenshot attachment — but loop's shell answered `pickElement` with a
 * rejection, which `PreviewView` swallows as a silent cancel. So the button
 * armed itself and then quietly did nothing.
 *
 * Upstream ships a preload into the guest to do this. loop deliberately does
 * not (`WEBVIEW_PREFERENCES` keeps the guest sandboxed with context isolation),
 * so the picker is injected on demand with `executeJavaScript` instead: the
 * script returns a promise, and the value it resolves with is the pick. Nothing
 * is left in the page once a pick settles.
 */

/** What the injected script hands back. Keep in step with PICKER_SCRIPT. */
export interface PickedGuestElement {
  readonly pageUrl: string;
  readonly pageTitle: string | null;
  readonly tagName: string;
  readonly selector: string | null;
  readonly htmlPreview: string;
  readonly componentName: string | null;
  readonly styles: string;
  /** CSS pixels, relative to the guest viewport. */
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** The guest viewport in CSS pixels, so a crop can be clamped to the page. */
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface PreviewAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewAnnotationPayload {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  comment: string;
  elements: ReadonlyArray<{
    id: string;
    element: {
      pageUrl: string;
      pageTitle: string | null;
      tagName: string;
      selector: string | null;
      htmlPreview: string;
      componentName: string | null;
      source: null;
      stack: ReadonlyArray<never>;
      styles: string;
      pickedAt: string;
    };
    rect: PreviewAnnotationRect;
  }>;
  regions: ReadonlyArray<never>;
  strokes: ReadonlyArray<never>;
  styleChanges: ReadonlyArray<never>;
  screenshot: {
    dataUrl: string;
    width: number;
    height: number;
    cropRect: PreviewAnnotationRect;
  } | null;
  createdAt: string;
}

/** Breathing room around the picked element so the crop shows its context. */
const SCREENSHOT_PADDING = 8;

/**
 * The picked rect in the guest's *view* pixels, which is what `capturePage`
 * takes: page zoom scales CSS pixels, and a crop that ignores it lands
 * somewhere else entirely on any tab the user has zoomed.
 *
 * `viewport` is the guest's own CSS-pixel viewport, not the size of a captured
 * image: `capturePage` hands back device pixels, so on a 2x display clamping
 * against the image would let a crop run twice as far as the page goes.
 */
export function screenshotCropRect(
  rect: PickedGuestElement["rect"],
  zoomFactor: number,
  viewport: PickedGuestElement["viewport"],
): PreviewAnnotationRect | null {
  const zoom = zoomFactor > 0 ? zoomFactor : 1;
  const maxRight = Math.round(viewport.width * zoom);
  const maxBottom = Math.round(viewport.height * zoom);
  const left = Math.max(0, Math.floor(rect.x * zoom) - SCREENSHOT_PADDING);
  const top = Math.max(0, Math.floor(rect.y * zoom) - SCREENSHOT_PADDING);
  const right = Math.min(maxRight, Math.ceil((rect.x + rect.width) * zoom) + SCREENSHOT_PADDING);
  const bottom = Math.min(maxBottom, Math.ceil((rect.y + rect.height) * zoom) + SCREENSHOT_PADDING);
  const width = right - left;
  const height = bottom - top;
  // An element scrolled out of view, or collapsed to nothing, has no crop —
  // the caller falls back to the whole page rather than capturing 0x0.
  if (width <= 0 || height <= 0) return null;
  return { x: left, y: top, width, height };
}

export function buildAnnotationPayload(input: {
  readonly picked: PickedGuestElement;
  readonly screenshot: PreviewAnnotationPayload["screenshot"];
  readonly now: Date;
}): PreviewAnnotationPayload {
  const pickedAt = input.now.toISOString();
  const suffix = Math.random().toString(36).slice(2, 8);
  const id = `annotation-${input.now.getTime().toString(36)}-${suffix}`;
  return {
    id,
    pageUrl: input.picked.pageUrl,
    pageTitle: input.picked.pageTitle,
    // The comment rides in the chat composer the pick lands in, so there is no
    // second box to fill in inside the page.
    comment: "",
    elements: [
      {
        id: `${id}-element`,
        element: {
          pageUrl: input.picked.pageUrl,
          pageTitle: input.picked.pageTitle,
          tagName: input.picked.tagName,
          selector: input.picked.selector,
          htmlPreview: input.picked.htmlPreview,
          componentName: input.picked.componentName,
          // Source attribution needs React's owner stacks plus a source map;
          // the selector and HTML preview stand in until that exists.
          source: null,
          stack: [],
          styles: input.picked.styles,
          pickedAt,
        },
        rect: input.picked.rect,
      },
    ],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: input.screenshot,
    createdAt: pickedAt,
  };
}

/**
 * Injected into the guest's main world. Resolves with a `PickedGuestElement`,
 * or `null` when the user presses Escape or another pick supersedes this one.
 */
export const PICKER_SCRIPT = String.raw`
(() => new Promise((resolve) => {
  const previous = window.__loopPreviewPickCancel;
  if (typeof previous === "function") previous();

  const HIGHLIGHT_ID = "__loop-preview-pick-highlight";
  document.getElementById(HIGHLIGHT_ID)?.remove();

  const highlight = document.createElement("div");
  highlight.id = HIGHLIGHT_ID;
  highlight.setAttribute("aria-hidden", "true");
  highlight.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "pointer-events:none",
    "border:2px solid #3b82f6",
    "border-radius:2px",
    "background:rgba(59,130,246,0.16)",
    "box-shadow:0 0 0 1px rgba(255,255,255,0.6)",
    "transition:all 60ms ease-out",
    "display:none",
  ].join(";");

  const label = document.createElement("div");
  label.style.cssText = [
    "position:absolute",
    "left:0",
    "top:-22px",
    "padding:1px 6px",
    "border-radius:4px",
    "background:#3b82f6",
    "color:#fff",
    "font:500 11px/16px ui-sans-serif,system-ui,sans-serif",
    "white-space:nowrap",
  ].join(";");
  highlight.appendChild(label);

  const previousCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";
  (document.body || document.documentElement).appendChild(highlight);

  let current = null;

  const describeName = (element) => {
    const id = element.id ? "#" + element.id : "";
    const className =
      typeof element.className === "string" && element.className.trim()
        ? "." + element.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    return element.tagName.toLowerCase() + id + className;
  };

  const cssEscape = (value) =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&");

  const buildSelector = (element) => {
    try {
      if (element.id) return "#" + cssEscape(element.id);
      const parts = [];
      let node = element;
      while (node && node.nodeType === 1 && parts.length < 6) {
        if (node.id) {
          parts.unshift("#" + cssEscape(node.id));
          break;
        }
        const tag = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.prototype.filter.call(
          parent.children,
          (child) => child.tagName === node.tagName,
        );
        parts.unshift(
          siblings.length > 1 ? tag + ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")" : tag,
        );
        node = parent;
      }
      return parts.join(" > ") || null;
    } catch {
      return null;
    }
  };

  // Best effort: React hangs a fiber off the DOM node in dev builds. Walking
  // up it names the component the element came from, which is the difference
  // between "a div" and "the PricingCard".
  const componentName = (element) => {
    try {
      const key = Object.keys(element).find(
        (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"),
      );
      let fiber = key ? element[key] : null;
      let depth = 0;
      while (fiber && depth < 24) {
        const type = fiber.type;
        const name =
          typeof type === "function"
            ? type.displayName || type.name
            : type && typeof type === "object"
              ? type.displayName || (type.render && (type.render.displayName || type.render.name))
              : null;
        if (name) return name;
        fiber = fiber.return;
        depth += 1;
      }
    } catch {
      // Not a React page, or a production build with mangled names.
    }
    return null;
  };

  const INTERESTING_STYLES = [
    "display", "position", "width", "height", "margin", "padding", "color",
    "background-color", "font-family", "font-size", "font-weight", "line-height",
    "border", "border-radius", "box-shadow", "opacity", "z-index",
  ];

  const styles = (element) => {
    try {
      const computed = window.getComputedStyle(element);
      return INTERESTING_STYLES.map((property) => {
        const value = computed.getPropertyValue(property);
        return value ? property + ": " + value + ";" : "";
      })
        .filter(Boolean)
        .join("\n");
    } catch {
      return "";
    }
  };

  // Everything the page could otherwise react to. A press that reaches the page
  // opens menus, applies :active styles, follows links — and then the crop main
  // takes a moment later is of a page that already moved on.
  const SWALLOWED = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "auxclick",
    "dblclick",
    "contextmenu",
  ];

  const removePointerListeners = () => {
    for (const type of SWALLOWED) document.removeEventListener(type, onPointer, true);
  };

  const cleanup = (keepSwallowing) => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("keydown", onKey, true);
    document.documentElement.style.cursor = previousCursor;
    highlight.remove();
    if (window.__loopPreviewPickCancel === cancel) delete window.__loopPreviewPickCancel;
    // The press that picks is followed by mouseup and click. Tearing the
    // swallowers down with everything else hands those to the page, and a link
    // navigates away before the host has taken its screenshot — which is how a
    // pick ends up looking like it captured the wrong thing entirely.
    if (!keepSwallowing) {
      removePointerListeners();
      return;
    }
    setTimeout(removePointerListeners, 500);
  };

  const finish = (value) => {
    cleanup(value !== null);
    // The highlight is out of the DOM but not yet off the screen. The host
    // screenshots the instant this resolves, and a frame that still has the
    // picker's own border painted over the element is not a picture of the
    // page — so wait for the removal to actually paint.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    setTimeout(settle, 120);
    requestAnimationFrame(() => requestAnimationFrame(settle));
  };

  const cancel = () => finish(null);

  // The deepest node under the cursor is usually what someone means — except
  // inside an icon, where every path and tspan is a separate node and nobody is
  // pointing at "path". Climb out to the element that owns the drawing.
  const resolveTarget = (node) => {
    let element = node;
    while (
      element &&
      element.parentElement &&
      /^(path|g|use|tspan|textpath|polygon|polyline|circle|ellipse|rect|line|defs|symbol)$/i.test(
        element.tagName,
      )
    ) {
      element = element.parentElement;
    }
    return element;
  };

  // How many parents up from the hovered node the selection sits. The deepest
  // element is rarely wrong, but on an icon button or a padded card it is not
  // what was meant — arrow keys widen and narrow instead of making us guess.
  let climb = 0;

  const target = () => {
    let element = current;
    for (let step = 0; step < climb && element?.parentElement; step += 1) {
      if (element.parentElement === document.documentElement) break;
      element = element.parentElement;
    }
    return element;
  };

  const paint = () => {
    const element = target();
    if (!element) return;
    const rect = element.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.left = rect.left + "px";
    highlight.style.top = rect.top + "px";
    highlight.style.width = rect.width + "px";
    highlight.style.height = rect.height + "px";
    label.textContent =
      describeName(element) +
      "  " +
      Math.round(rect.width) +
      "×" +
      Math.round(rect.height) +
      (climb > 0 ? "  ↑" + climb : "");
  };

  function onMove(event) {
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const element = hovered && hovered !== highlight ? resolveTarget(hovered) : null;
    if (!element) return;
    if (element !== current) climb = 0;
    current = element;
    paint();
  }

  function onPointer(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    // Only the press picks; the rest are swallowed so the page stays put.
    if (event.type !== "pointerdown" && event.type !== "mousedown") return;
    // What the highlight was showing is what gets picked — re-resolving from
    // the pointer here would hand back whatever the press revealed instead.
    if (!current) {
      current = resolveTarget(document.elementFromPoint(event.clientX, event.clientY));
      climb = 0;
    }
    const element = target() ?? document.body;
    const rect = element.getBoundingClientRect();
    finish({
      pageUrl: location.href,
      pageTitle: document.title || null,
      tagName: element.tagName.toLowerCase(),
      selector: buildSelector(element),
      htmlPreview: (element.outerHTML || "").slice(0, 600),
      componentName: componentName(element),
      styles: styles(element),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      viewport: {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
      },
    });
  }

  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    climb = event.key === "ArrowUp" ? climb + 1 : Math.max(0, climb - 1);
    paint();
  }

  // Deliberately no blur handler: switching apps or opening devtools mid-pick
  // would cancel it, and the toggle button and Escape already do that on
  // purpose.
  document.addEventListener("mousemove", onMove, true);
  for (const type of SWALLOWED) document.addEventListener(type, onPointer, true);
  document.addEventListener("keydown", onKey, true);
  window.__loopPreviewPickCancel = cancel;
}))()
`;

/** Tears down a pick already running in the guest. Safe to run when none is. */
export const CANCEL_PICKER_SCRIPT = String.raw`
(() => {
  const cancel = window.__loopPreviewPickCancel;
  if (typeof cancel === "function") cancel();
  return null;
})()
`;
