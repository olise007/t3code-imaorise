import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly confirmLabel?: string;
    }
  | {
      readonly status: "closing";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly confirmLabel?: string;
    };

type PendingConfirmation = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly confirmLabel?: string;
  readonly resolve: (confirmed: boolean) => void;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(confirmed: boolean): void {
  activeConfirmation?.resolve(confirmed);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(confirmed);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers the renderer host that can present themed confirmations. The
 * returned cleanup function also cancels any request left without a host.
 */
export function registerConfirmDialogHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);

    if (registeredHostCount === 0) {
      resolvePendingConfirmations(false);
      publish(idleState);
    }
  };
}

/**
 * Requests a themed confirmation when a host is mounted. An undefined result
 * means no themed host is currently available.
 */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions & { confirmLabel?: string; signal?: AbortSignal },
): Promise<boolean> | undefined {
  if (registeredHostCount === 0) return undefined;
  if (options?.signal?.aborted) return Promise.resolve(false);

  const confirmation = new Promise<boolean>((resolve) => {
    const abort = () => {
      if (activeConfirmation === pending) respondToConfirmDialog(false);
      else {
        queuedConfirmations = queuedConfirmations.filter((entry) => entry !== pending);
        pending.resolve(false);
      }
    };
    const pending = {
      message,
      variant: options?.variant ?? "default",
      ...(options?.confirmLabel ? { confirmLabel: options.confirmLabel } : {}),
      resolve: (confirmed: boolean) => {
        options?.signal?.removeEventListener("abort", abort);
        resolve(confirmed);
      },
    } satisfies PendingConfirmation;
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({
      status: "confirming",
      message,
      variant: pending.variant,
      ...(pending.confirmLabel ? { confirmLabel: pending.confirmLabel } : {}),
    });
  });

  return confirmation;
}

/** True while a confirmation is shown, closing, or waiting to be shown. */
export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({
    status: "closing",
    message: state.message,
    variant: state.variant,
    ...(state.confirmLabel ? { confirmLabel: state.confirmLabel } : {}),
  });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({
    status: "confirming",
    message: next.message,
    variant: next.variant,
    ...(next.confirmLabel ? { confirmLabel: next.confirmLabel } : {}),
  });
}

export function resetConfirmDialogForTests(): void {
  resolvePendingConfirmations(false);
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
