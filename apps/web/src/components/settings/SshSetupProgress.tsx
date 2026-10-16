import { useRef, useState, useSyncExternalStore } from "react";
import { sshSetupProgress, type SshSetupAttempt } from "../../connection/sshSetupProgress";
import { cancelSshEnvironmentSetup } from "../../connection/onboarding";
import { Button } from "../ui/button";

function Attempt({ attempt }: { attempt: SshSetupAttempt }) {
  const [open, setOpen] = useState(false);
  const following = useRef(true);
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm">
          {attempt.target.manual?.name || attempt.target.alias} · {attempt.status}
          <span className="block text-xs text-muted-foreground">{attempt.lines.at(-1)?.text}</span>
        </p>
        <div className="flex gap-2">
          <Button size="xs" variant="outline" onClick={() => setOpen(!open)}>
            {open ? "Hide progress" : "View progress"}
          </Button>
          {attempt.status === "running" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void cancelSshEnvironmentSetup(attempt.target);
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
          <details>
            <summary className="cursor-pointer text-xs">Live details</summary>
            <pre
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs"
              onScroll={(event) => {
                const view = event.currentTarget;
                following.current = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
              }}
              ref={(node) => {
                if (node && following.current) node.scrollTop = node.scrollHeight;
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
              void navigator.clipboard.writeText(
                `${attempt.truncated ? "[Earlier output truncated]\n" : ""}${attempt.lines.map((line) => `${new Date(line.time).toISOString()} ${line.text}`).join("\n")}`,
              );
            }}
          >
            Copy details
          </Button>
        </>
      ) : null}
    </div>
  );
}

export function SshSetupProgress() {
  const attempts = useSyncExternalStore(sshSetupProgress.subscribe, sshSetupProgress.snapshot);
  return (
    <div className="space-y-2">
      {[...attempts].reverse().map((attempt) => (
        <Attempt key={attempt.id} attempt={attempt} />
      ))}
    </div>
  );
}
