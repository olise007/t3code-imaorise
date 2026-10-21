import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { DIRECT_ACTIVITY_PATH } from "@t3tools/contracts";
import type { DirectAlertTarget } from "./directAlerts";

/** Never probe unsupported servers or substitute a relay/SSH identity for a paired route. */
export function directAlertTarget(
  prepared: PreparedConnection | null,
  supported: boolean,
  scheme: string,
): DirectAlertTarget | null {
  if (
    !supported ||
    prepared?.target._tag !== "BearerConnectionTarget" ||
    prepared.httpAuthorization?._tag !== "Bearer"
  )
    return null;
  return {
    environmentId: prepared.environmentId,
    url: new URL(DIRECT_ACTIVITY_PATH, prepared.httpBaseUrl).toString(),
    token: prepared.httpAuthorization.token,
    scheme,
  };
}
