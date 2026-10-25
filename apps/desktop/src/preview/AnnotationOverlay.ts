const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"]';
const MODAL_SELECTOR =
  'dialog:modal, [aria-modal="true"]:is([role="dialog"], [role="alertdialog"])';
export const ANNOTATION_UI_ATTRIBUTE = "data-t3code-annotation-ui";

export function isAnnotationNode(element: EventTarget | null): boolean {
  return element instanceof Element && element.closest(`[${ANNOTATION_UI_ATTRIBUTE}]`) !== null;
}

function isVisible(element: Element, hasOpacityPreview?: (element: Element) => boolean): boolean {
  if (!element.isConnected) return false;
  const visibleOpacity = element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  if (
    !visibleOpacity &&
    (!hasOpacityPreview || !element.checkVisibility({ checkVisibilityCSS: true }))
  )
    return false;
  // A native modal escapes an inert ancestor, but its own inert descendants do not.
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true")
      return false;
    // Only annotation-owned opacity previews may keep an invisible target editable.
    if (
      !visibleOpacity &&
      getComputedStyle(ancestor).opacity === "0" &&
      !hasOpacityPreview?.(ancestor)
    )
      return false;
    if (ancestor.matches("dialog:modal")) break;
  }
  return true;
}

function hasArea(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function enclosingDialog(
  element: Element | null,
  hasOpacityPreview: (element: Element) => boolean,
): Element | null {
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    if (
      ancestor.matches(DIALOG_SELECTOR) &&
      isVisible(ancestor, hasOpacityPreview) &&
      hasArea(ancestor)
    )
      return ancestor;
  }
  return null;
}

/** Keeps the same editor inside the page's focus scope and above its top-layer content. */
export function createAnnotationOverlay(
  host: HTMLElement,
  shadowRoot: ShadowRoot,
  onPlacementChange: () => void,
  hasOpacityPreview: (element: Element) => boolean,
) {
  let focusBoundary: Element | null = null;
  let selectionBoundary: Element | null = null;
  let frame: number | null = null;
  let disposed = false;
  let reconciling = false;

  const pageElementAtPoint = (x: number, y: number): Element | null =>
    document.elementsFromPoint(x, y).find((element) => !isAnnotationNode(element)) ?? null;

  const resolveFocusBoundary = (preferred?: Element): Element | null => {
    for (const element of [preferred, document.activeElement]) {
      if (!element || isAnnotationNode(element)) continue;
      const dialog = enclosingDialog(element, hasOpacityPreview);
      if (dialog) return dialog;
    }
    const dialogs = Array.from(document.querySelectorAll(DIALOG_SELECTOR)).filter(
      (dialog) => isVisible(dialog, hasOpacityPreview) && hasArea(dialog),
    );
    // DOM order is not top-layer order. Hit-testing also finds the active native
    // dialog when its backdrop covers an older dialog elsewhere in the document.
    for (const dialog of dialogs.toReversed()) {
      const rect = dialog.getBoundingClientRect();
      const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
      const front = enclosingDialog(pageElementAtPoint(x, y), hasOpacityPreview);
      if (front) return front;
    }
    return focusBoundary && dialogs.includes(focusBoundary)
      ? focusBoundary
      : (dialogs.at(-1) ?? null);
  };

  const reconcile = (preferred?: Element): void => {
    if (disposed || reconciling) return;
    reconciling = true;
    try {
      const nextFocusBoundary = resolveFocusBoundary(preferred);
      const parent = nextFocusBoundary ?? document.documentElement;
      // Non-modal dialogs can own focus without making the rest of the page ineligible.
      const nextBoundary = nextFocusBoundary?.closest(MODAL_SELECTOR) ?? null;
      const changed =
        focusBoundary !== nextFocusBoundary ||
        selectionBoundary !== nextBoundary ||
        host.parentElement !== parent;
      const focused = shadowRoot.activeElement;
      const selection =
        focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
          ? {
              start: focused.selectionStart,
              end: focused.selectionEnd,
              direction: focused.selectionDirection,
            }
          : null;
      focusBoundary = nextFocusBoundary;
      selectionBoundary = nextBoundary;
      if (host.parentElement !== parent) {
        if (host.matches(":popover-open")) host.hidePopover();
        parent.appendChild(host);
      }
      if (!host.matches(":popover-open")) host.showPopover();
      if (changed && focused instanceof HTMLElement && focused.isConnected) {
        focused.focus({ preventScroll: true });
        if (
          selection?.start !== null &&
          selection?.start !== undefined &&
          selection.end !== null &&
          (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement)
        )
          focused.setSelectionRange(
            selection.start,
            selection.end,
            selection.direction ?? undefined,
          );
      }
      if (changed) onPlacementChange();
    } finally {
      reconciling = false;
    }
  };

  const queueReconcile = (): void => {
    if (disposed || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      reconcile();
    });
  };
  const onFocus = (event: FocusEvent): void => {
    if (event.target instanceof Element && !isAnnotationNode(event.target)) reconcile(event.target);
  };
  const onModalChange = (event: Event): void => {
    if (event.target instanceof Element && !isAnnotationNode(event.target)) queueReconcile();
  };
  const observer = new MutationObserver((records) => {
    if (disposed) return;
    if (
      !host.isConnected ||
      records.some((record) => {
        if (isAnnotationNode(record.target)) return false;
        if (record.type === "attributes") {
          return (
            record.target instanceof Element &&
            (record.target.matches(DIALOG_SELECTOR) ||
              record.target === focusBoundary ||
              (focusBoundary !== null && record.target.contains(focusBoundary)))
          );
        }
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            !isAnnotationNode(node) &&
            (node === focusBoundary ||
              (focusBoundary !== null && node.contains(focusBoundary)) ||
              node.matches(DIALOG_SELECTOR) ||
              node.querySelector(DIALOG_SELECTOR) !== null),
        );
      })
    )
      queueReconcile();
  });

  const isInScope = (element: Element): boolean =>
    element !== document.documentElement &&
    element !== document.body &&
    !isAnnotationNode(element) &&
    (selectionBoundary === null || selectionBoundary.contains(element));

  const isEligible = (element: Element): boolean =>
    isInScope(element) && isVisible(element) && hasArea(element);

  return {
    reconcile,
    isEligible,
    canRetainSelection(element: Element): boolean {
      return isInScope(element) && isVisible(element, hasOpacityPreview) && hasArea(element);
    },
    pickFromPoint(x: number, y: number): Element | null {
      for (let element = pageElementAtPoint(x, y); element; element = element.parentElement) {
        if (!isInScope(element) || !isVisible(element)) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Native dialog backdrops retarget to the dialog even outside its bounds.
          return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
            ? element
            : null;
        }
        // SVG geometry bounds omit strokes. A visible line can have zero width
        // or height; select its first visible ancestor with a usable capture area.
        if (!(element instanceof SVGElement)) return null;
      }
      return null;
    },
    mount(): void {
      reconcile();
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          "open",
          "role",
          "aria-modal",
          "aria-hidden",
          "inert",
          "hidden",
          "class",
          "style",
        ],
      });
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("toggle", onModalChange, true);
      document.addEventListener("close", onModalChange, true);
    },
    dispose(): void {
      disposed = true;
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("toggle", onModalChange, true);
      document.removeEventListener("close", onModalChange, true);
      if (host.matches(":popover-open")) host.hidePopover();
      host.remove();
    },
  };
}
