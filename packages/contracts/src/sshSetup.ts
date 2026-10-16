import * as Schema from "effect/Schema";

export const SshRuntimeRequirements = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeVersion: Schema.String,
  platform: Schema.Literals(["linux", "windows"]),
  architecture: Schema.Literal("x64"),
  nodeVersion: Schema.String,
  minimumGlibc: Schema.String,
  minimumGlibcxx: Schema.String,
  minimumKernel: Schema.String,
  libraries: Schema.Array(Schema.String),
});
export type SshRuntimeRequirements = typeof SshRuntimeRequirements.Type;

export const SshPrerequisiteItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  installed: Schema.Boolean,
  required: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  packages: Schema.Array(Schema.String),
  guidance: Schema.String,
});
export const SshProviderChoice = Schema.Struct({
  driver: Schema.String,
  label: Schema.String,
  version: Schema.NullOr(Schema.String),
  source: Schema.String,
  command: Schema.String,
  available: Schema.Boolean,
  installed: Schema.Boolean,
  reason: Schema.String,
  dependencies: Schema.Array(Schema.String),
});
export type SshProviderChoice = typeof SshProviderChoice.Type;

export const SshSetupReview = Schema.Struct({
  reviewId: Schema.String,
  destination: Schema.String,
  source: Schema.String,
  remoteIdentity: Schema.String,
  platform: Schema.Literals(["linux", "windows"]),
  architecture: Schema.String,
  distribution: Schema.String,
  packageManager: Schema.Literals(["apt", "dnf", "yum", "none", "windows"]),
  elevation: Schema.Literals(["root", "sudo", "administrator", "unavailable"]),
  requirements: SshRuntimeRequirements,
  items: Schema.Array(SshPrerequisiteItem),
  commands: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.String),
  providers: Schema.Array(SshProviderChoice),
});
export type SshSetupReview = typeof SshSetupReview.Type;
export const SshSetupApproval = Schema.Struct({
  reviewId: Schema.String,
  approved: Schema.Boolean,
  providers: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
});
export type SshSetupApproval = typeof SshSetupApproval.Type;
