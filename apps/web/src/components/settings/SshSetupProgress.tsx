import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sshSetupProgress, type SshSetupAttempt } from "../../connection/sshSetupProgress";
import { cancelSshEnvironmentSetup } from "../../connection/onboarding";
import { Button } from "../ui/button";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";

const views = new Map<
  string,
  { open: boolean; following: boolean; scrollTop: number; detailsOpen: boolean }
>();

function Attempt({ attempt }: { attempt: SshSetupAttempt }) {
  const [open, setOpen] = useState(views.get(attempt.id)?.open ?? false);
  const [error, setError] = useState<string | null>(null);
  const view = useRef(
    views.get(attempt.id) ?? { open: false, following: true, scrollTop: 0, detailsOpen: false },
  );
  views.set(attempt.id, view.current);
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm">
          {attempt.target.manual?.name || attempt.target.alias} · {attempt.status}
          <span className="block text-xs text-muted-foreground">{attempt.lines.at(-1)?.text}</span>
        </p>
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              view.current.open = !open;
              setOpen(!open);
            }}
          >
            {open ? "Hide progress" : "View progress"}
          </Button>
          {attempt.status === "running" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void cancelSshEnvironmentSetup(attempt.target).catch(() =>
                  setError(
                    "Could not confirm cancellation. Check the active setup before retrying.",
                  ),
                );
              }}
            >
              Cancel setup
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <>
          <ol className="space-y-1 text-xs">
            {attempt.lines
              .filter(
                (line, index) =>
                  !line.text.startsWith("Details:") &&
                  (index === 0 || line.text !== attempt.lines[index - 1]?.text),
              )
              .map((line) => (
                <li key={line.sequence}>
                  {new Date(line.time).toLocaleTimeString()} · {line.text}
                </li>
              ))}
          </ol>
          <details
            open={view.current.detailsOpen}
            onToggle={(event) => {
              view.current.detailsOpen = event.currentTarget.open;
              const pre = event.currentTarget.querySelector("pre");
              if (pre && event.currentTarget.open)
                pre.scrollTop = view.current.following ? pre.scrollHeight : view.current.scrollTop;
            }}
          >
            <summary className="cursor-pointer text-xs">Live details</summary>
            <pre
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs"
              onScroll={(event) => {
                const view = event.currentTarget;
                const state = views.get(attempt.id)!;
                state.following = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
                state.scrollTop = view.scrollTop;
              }}
              ref={(node) => {
                if (node)
                  node.scrollTop = view.current.following
                    ? node.scrollHeight
                    : view.current.scrollTop;
              }}
            >
              {attempt.truncated ? "[Earlier output truncated]\n" : ""}
              {attempt.lines
                .map((line) => `${new Date(line.time).toISOString()} ${line.text}`)
                .join("\n")}
            </pre>
          </details>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              void writeTextToClipboard(
                `${attempt.truncated ? "[Earlier output truncated]\n" : ""}${attempt.lines.map((line) => `${new Date(line.time).toISOString()} ${line.text}`).join("\n")}`,
              ).catch(() =>
                setError(
                  "Could not copy the details. Select the text in Live details to copy it manually.",
                ),
              );
            }}
          >
            Copy details
          </Button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SshSetupProgress() {
  const attempts = useSyncExternalStore(sshSetupProgress.subscribe, sshSetupProgress.snapshot);
  useEffect(() => {
    const ids = new Set(attempts.map((attempt) => attempt.id));
    for (const id of views.keys()) if (!ids.has(id)) views.delete(id);
  }, [attempts]);
  return (
    <div className="space-y-2">
      {attempts.toReversed().map((attempt) => (
        <Attempt key={attempt.id} attempt={attempt} />
      ))}
    </div>
  );
}
