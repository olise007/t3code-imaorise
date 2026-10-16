/** Buffer whole lines before redaction so chunk boundaries cannot leak a URL or secret. */
export function createSetupDetails(onLine: (line: string) => void) {
  let pending = "";
  let discarding = false;
  const emit = (line: string) => {
    const clean = line
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    if (
      /PRIVATE KEY|authorization|password|passphrase|access.?token|refresh.?token|device.?code|user.?code|code_verifier|T3_SSH_.*PROMPT/i.test(
        clean,
      )
    ) {
      onLine("[Sensitive output omitted]");
      return;
    }
    onLine(
      clean
        .replace(/https?:\/\/\S+/gi, "[address omitted]")
        .replace(/\b(?:token|secret|credential|state|code)\s*[:=].*/gi, "[credential omitted]"),
    );
  };
  return {
    push(chunk: string) {
      for (const part of chunk.split(/(?<=\n)/)) {
        if (!discarding) pending += part;
        if (pending.length > 8192) {
          pending = "";
          discarding = true;
        }
        if (part.endsWith("\n")) {
          if (discarding) onLine("[Oversized output line omitted]");
          else if (pending.trim()) emit(pending.trimEnd());
          pending = "";
          discarding = false;
        }
      }
    },
    finish() {
      if (discarding) onLine("[Oversized output line omitted]");
      else if (pending.trim()) emit(pending.trimEnd());
      pending = "";
      discarding = false;
    },
  };
}
