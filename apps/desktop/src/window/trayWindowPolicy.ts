let available = false;
let quitting = false;
export const setTrayAvailable = (value: boolean) => {
  available = value;
};
export const beginTrayQuit = () => {
  quitting = true;
};
export function shouldHideToTray(enabled: boolean) {
  return available && !quitting && enabled;
}

/** Decide close synchronously; configuration is read before hiding or re-closing. */
export function handleTrayClose(input: {
  event: { preventDefault: () => void };
  canUseTray: boolean;
  getEnabled: () => Promise<boolean>;
  hide: () => void;
  close: () => void;
  bypass: boolean;
  setBypass: () => void;
}) {
  if (!input.canUseTray || input.bypass) return;
  input.event.preventDefault();
  void input
    .getEnabled()
    .then((enabled) => {
      if (shouldHideToTray(enabled)) input.hide();
      else {
        input.setBypass();
        input.close();
      }
    })
    .catch(() => {
      input.setBypass();
      input.close();
    });
}
