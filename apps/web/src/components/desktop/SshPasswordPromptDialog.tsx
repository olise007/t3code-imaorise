import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

function describeSshTarget(request: DesktopSshPasswordPromptRequest): string {
  return request.username ? `${request.username}@${request.destination}` : request.destination;
}

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getPromptErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "SSH password prompt failed.";
  return message.includes("expired") || message.includes("no longer pending")
    ? "This SSH password prompt expired. Try connecting again."
    : message;
}

export function SshPasswordPromptDialog() {
  const [queue, setQueue] = useState<readonly DesktopSshPasswordPromptRequest[]>([]);
  const currentRequest = queue[0] ?? null;

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onSshPasswordPrompt) {
      return;
    }

    return bridge.onSshPasswordPrompt((request) => {
      setQueue((currentQueue) => [...currentQueue, request]);
    });
  }, []);

  if (!currentRequest) {
    return null;
  }

  if (currentRequest.purpose === "setup-review" && currentRequest.setupReview)
    return (
      <SshSetupReviewDialog
        key={currentRequest.requestId}
        request={currentRequest}
        onRemove={() => setQueue((queue) => queue.slice(1))}
      />
    );

  return (
    <ActiveSshPasswordPrompt
      key={currentRequest.requestId}
      request={currentRequest}
      onRemove={(requestId) => {
        setQueue((currentQueue) =>
          currentQueue[0]?.requestId === requestId ? currentQueue.slice(1) : currentQueue,
        );
      }}
    />
  );
}

function ActiveSshPasswordPrompt({
  request,
  onRemove,
}: {
  readonly request: DesktopSshPasswordPromptRequest;
  readonly onRemove: (requestId: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [responseError, setResponseError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRespondingRef = useRef(false);
  const formId = useId();

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const expiresAtMs = Date.parse(request.expiresAt);
  const remainingMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - now) : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const remainingLabel =
    remainingSeconds === null ? null : formatRemainingSeconds(remainingSeconds);
  const visibleResponseError = isExpired
    ? "This SSH password prompt expired. Try connecting again."
    : responseError;

  const respond = async (nextPassword: string | null) => {
    if (isRespondingRef.current) {
      return;
    }

    const requestId = request.requestId;
    if (nextPassword !== null && isExpired) {
      setResponseError("This SSH password prompt expired. Try connecting again.");
      return;
    }

    isRespondingRef.current = true;
    setIsResponding(true);
    setResponseError(null);
    try {
      await window.desktopBridge?.resolveSshPasswordPrompt(requestId, nextPassword);
      onRemove(requestId);
    } catch (error) {
      if (nextPassword === null) {
        onRemove(requestId);
      } else {
        setResponseError(getPromptErrorMessage(error));
      }
    } finally {
      isRespondingRef.current = false;
      setIsResponding(false);
    }
  };

  const dismissExpiredPrompt = () => {
    onRemove(request.requestId);
  };

  const cancelPrompt = () => {
    if (isExpired) {
      dismissExpiredPrompt();
      return;
    }
    void respond(null);
  };

  const target = describeSshTarget(request);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          cancelPrompt();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {request.prompt.startsWith("Verify SSH host key")
              ? "Verify SSH host key"
              : request.purpose === "elevation"
                ? "Remote package installation: sudo"
                : "SSH authentication required"}
          </DialogTitle>
          <DialogDescription>
            {request.prompt.startsWith("Verify SSH host key") ? (
              <>
                Check the fingerprint for <code>{target}</code> before trusting this host.
              </>
            ) : request.purpose === "elevation" ? (
              <>
                Enter the remote sudo password for the packages you approved. This credential is
                separate from SSH authentication and is never saved.
              </>
            ) : (
              <>
                Enter the{" "}
                {request.challenge === "key-passphrase" ? "private key passphrase" : "SSH password"}{" "}
                for <code>{target}</code>. It is passed to the selected SSH client and is not saved
                by T3 Code.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <form
            className="space-y-3"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void respond(password);
            }}
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">{request.prompt}</p>
                {remainingLabel ? (
                  <span
                    className={
                      isExpired
                        ? "shrink-0 text-xs font-medium text-destructive"
                        : "shrink-0 text-xs text-muted-foreground"
                    }
                  >
                    {isExpired ? "Expired" : remainingLabel}
                  </span>
                ) : null}
              </div>
              <Input
                ref={inputRef}
                autoComplete="current-password"
                disabled={isResponding || isExpired}
                name="ssh-password"
                type={request.prompt.startsWith("Verify SSH host key") ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {visibleResponseError ? (
              <p className="text-sm text-destructive">{visibleResponseError}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {request.purpose === "elevation"
                  ? "Cancelling leaves completed package installations in place."
                  : "Use SSH keys to avoid repeated password prompts on new SSH sessions."}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={isResponding} type="button" variant="outline" onClick={cancelPrompt}>
            {isExpired ? "Dismiss" : "Cancel"}
          </Button>
          <Button disabled={isResponding || isExpired} form={formId} type="submit">
            Continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SshSetupReviewDialog({
  request,
  onRemove,
}: {
  request: DesktopSshPasswordPromptRequest;
  onRemove: () => void;
}) {
  const review = request.setupReview!;
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(request.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [request.expiresAt]);
  const respond = async (approved: boolean) => {
    if (pending) return;
    setPending(true);
    try {
      await window.desktopBridge?.resolveSshSetupReview?.(
        request.requestId,
        approved ? { reviewId: review.reviewId, approved: true, providers: selected } : null,
      );
      onRemove();
    } catch {
      setError("This review expired or setup was cancelled. Start a new connection attempt.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void respond(false);
      }}
    >
      <DialogPopup className="max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Review remote setup</DialogTitle>
          <DialogDescription>
            Approve requirements for {review.destination}. Provider account sign-in happens
            separately after connection.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <div className="space-y-4 text-sm">
            <p>
              {review.platform} · {review.architecture} · {review.distribution} ·{" "}
              {review.packageManager}
              <br />
              Elevation: {review.elevation}. Runtime {review.requirements.runtimeVersion}, Node{" "}
              {review.requirements.nodeVersion}.
            </p>
            <details>
              <summary>SSH source and remote identity</summary>
              <p className="break-all">
                {review.source}
                <br />
                {review.remoteIdentity}
              </p>
            </details>
            <ul className="space-y-1">
              {review.items.map((item) => (
                <li key={item.id}>
                  {item.installed ? "✓" : "Missing:"} {item.label}
                  {!item.installed ? ` — ${item.guidance}` : ""}
                </li>
              ))}
            </ul>
            <div>
              <p>Approved system commands use the remote OS repositories:</p>
              <pre className="overflow-x-auto whitespace-pre-wrap">
                {review.commands.join("\n") || "No system package changes required."}
              </pre>
            </div>
            <fieldset className="space-y-3">
              <legend>Provider CLIs (optional)</legend>
              {review.providers.map((provider) => (
                <label key={provider.driver} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(provider.driver)}
                    disabled={!provider.available || pending || expired}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, provider.driver]
                          : current.filter((id) => id !== provider.driver),
                      )
                    }
                  />
                  <span>
                    {provider.label}
                    {provider.version ? ` ${provider.version}` : ""}
                    {provider.installed ? " — reuse existing executable" : ""}
                    <br />
                    <span className="text-muted-foreground">
                      {provider.reason} {provider.source}
                      {selected.includes(provider.driver) ? (
                        <>
                          <br />
                          {provider.command}
                          <br />
                          {provider.dependencies.join(", ")}
                        </>
                      ) : null}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {review.blockers.map((blocker) => (
              <p key={blocker} className="text-destructive">
                {blocker}
              </p>
            ))}
            <p>
              Cancellation stops setup and removes owned staging. Completed package installations
              remain. T3 will not change the OS, firewall, SSH server, or restart this machine.
            </p>
            {error || expired ? (
              <p className="text-destructive">
                {error ?? "This review expired. Start a new connection attempt."}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => void respond(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || expired || review.blockers.length > 0}
            onClick={() => void respond(true)}
          >
            Approve and continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
