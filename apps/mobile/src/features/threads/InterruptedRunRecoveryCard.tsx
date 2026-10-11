import { AuthOrchestrationOperateScope, MessageId, type EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { uuidv4 } from "../../lib/uuid";

export function InterruptedRunRecoveryCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  const permitted = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = thread.latestRun;
  if (run?.status !== "interrupted") return null;
  async function resume() {
    if (!run || !permitted || inFlight.current || submitted) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await startTurn({
        environmentId,
        input: {
          threadId: thread.id,
          manualContinuationOfRunId: run.runId,
          message: {
            messageId: MessageId.make(uuidv4()),
            role: "user",
            text: "Continue where you left off.",
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          dispatchMode: "start",
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not resume. Please retry.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-screen p-3">
      <Text className="text-sm text-foreground">
        Run interrupted. Resume to continue; check completed work before repeating commands.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Resume interrupted run"
        disabled={!permitted || pending || submitted}
        onPress={() => void resume()}
        className="min-h-11 justify-center self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
      >
        <Text className="text-sm text-foreground">
          {pending ? "Resuming…" : submitted ? "Resumed" : "Resume"}
        </Text>
      </Pressable>
      {error ? <Text className="text-sm text-warning-foreground">{error}</Text> : null}
    </View>
  );
}
