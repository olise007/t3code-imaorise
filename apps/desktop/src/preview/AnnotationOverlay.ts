const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"]';
export const ANNOTATION_UI_ATTRIBUTE = "data-t3code-annotation-ui";

export function isAnnotationNode(element: EventTarget | null): boolean {
  return element instanceof Element && element.closest(`[${ANNOTATION_UI_ATTRIBUTE}]`) !== null;
}

function isVisible(element: Element): boolean {
  if (
    !element.isConnected ||
    !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  )
    return false;
  // A native modal escapes an inert ancestor, but its own inert descendants do not.
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true")
      return false;
    if (ancestor.matches("dialog:modal")) break;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function enclosingDialog(element: Element | null): Element | null {
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.matches(DIALOG_SELECTOR) && isVisible(ancestor)) return ancestor;
  }
  return null;
}

/** Keeps the same editor inside the page's focus scope and above its top-layer content. */
export function createAnnotationOverlay(
  host: HTMLElement,
  shadowRoot: ShadowRoot,
  onPlacementChange: () => void,
) {
  let modal: Element | null = null;
  let frame: number | null = null;
  let disposed = false;
  let reconciling = false;

  const pageElementAtPoint = (x: number, y: number): Element | null =>
    document.elementsFromPoint(x, y).find((element) => !isAnnotationNode(element)) ?? null;

  const resolveModal = (preferred?: Element): Element | null => {
    for (const element of [preferred, document.activeElement]) {
      if (!element || isAnnotationNode(element)) continue;
      const dialog = enclosingDialog(element);
      if (dialog) return dialog;
    }
    const dialogs = Array.from(document.querySelectorAll(DIALOG_SELECTOR)).filter(isVisible);
    // DOM order is not top-layer order. Hit-testing also finds the active native
    // dialog when its backdrop covers an older dialog elsewhere in the document.
    for (const dialog of dialogs.toReversed()) {
      const rect = dialog.getBoundingClientRect();
      const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
      const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
      const front = enclosingDialog(pageElementAtPoint(x, y));
      if (front) return front;
    }
    return modal && dialogs.includes(modal) ? modal : (dialogs.at(-1) ?? null);
  };

  const reconcile = (preferred?: Element): void => {
    if (disposed || reconciling) return;
    reconciling = true;
    try {
      const nextModal = resolveModal(preferred);
      const parent = nextModal ?? document.documentElement;
      const changed = modal !== nextModal || host.parentElement !== parent;
      const focused = shadowRoot.activeElement;
      const selection =
        focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
          ? {
              start: focused.selectionStart,
              end: focused.selectionEnd,
              direction: focused.selectionDirection,
            }
          : null;
      modal = nextModal;
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
              record.target === modal ||
              (modal !== null && record.target.contains(modal)))
          );
        }
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            !isAnnotationNode(node) &&
            (node === modal ||
              (modal !== null && node.contains(modal)) ||
              node.matches(DIALOG_SELECTOR) ||
              node.querySelector(DIALOG_SELECTOR) !== null),
        );
      })
    )
      queueReconcile();
  });

  const isEligible = (element: Element): boolean =>
    element !== document.documentElement &&
    element !== document.body &&
    !isAnnotationNode(element) &&
    (modal === null || modal.contains(element)) &&
    isVisible(element);

  return {
    reconcile,
    isEligible,
    pickFromPoint(x: number, y: number): Element | null {
      const element = pageElementAtPoint(x, y);
      if (!element || !isEligible(element)) return null;
      const rect = element.getBoundingClientRect();
      // Native dialog backdrops retarget to the dialog even outside its bounds.
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
        ? element
        : null;
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
