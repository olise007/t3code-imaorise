import * as Schema from "effect/Schema";

// Lives in the same atomic record as token-sharing profiles. Native credentials
// remain in Codex's private home; this stores only the selected method and path.
export const CodexNativeSelection = Schema.Struct({
  mode: Schema.Literals(["native", "existing", "disconnected"]),
  homePath: Schema.String,
});
