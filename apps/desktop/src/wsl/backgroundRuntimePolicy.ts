// An explicit Exit and stop servers overrides persistence for this process's quit.
let forceStop = false;
export const requestStopServersOnExit = () => {
  forceStop = true;
};
export const shouldStopBackgroundServer = (appExit: boolean, keepRunning: boolean) =>
  !appExit || !keepRunning || forceStop;
