/** Concurrent stop requests share completion; a failed attempt remains retryable. */
export function makeManagedStop(stopChild: () => Promise<void>, cleanup: () => Promise<void>) {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= Promise.resolve()
      .then(stopChild)
      .then(cleanup)
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
}
