import { app, BrowserWindow, clipboard } from "electron";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../src/preview/WebviewPreferences.ts";
import {
  START_PICK_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_SEND_ENABLED_CHANNEL,
} from "../../src/preview/GuestProtocol.ts";

async function main() {
  const profile = process.env.T3_ANNOTATION_PROFILE_DIR;
  const preload = process.env.T3_ANNOTATION_PRELOAD_PATH;
  const fixturePage = process.env.T3_ANNOTATION_FIXTURE_PAGE;
  const evidence = process.env.T3_ANNOTATION_EVIDENCE_DIR;
  if (![profile, preload, fixturePage].every((path) => path && NodePath.isAbsolute(path)))
    throw new Error("Explicit disposable fixture paths are required.");
  app.setPath("userData", profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256");
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    useContentSize: true,
    show: true,
    webPreferences: {
      ...Object.fromEntries(
        PREVIEW_WEBVIEW_PREFERENCES.split(",").map((entry) => {
          const [key, value] = entry.split("=");
          return [key, value === "true"];
        }),
      ),
      preload,
    },
  });
  window.setMenu(null);
  const errors = [];
  window.webContents.on("preload-error", (_event, _path, error) => errors.push(String(error)));
  const results = [];
  let resolveResult;
  let sequence = 0;
  window.webContents.ipc.on(
    ELEMENT_PICKED_CHANNEL,
    async (_event, annotation, crop, submission, scale) => {
      let screenshot = null;
      if (annotation) {
        const image = await window.webContents.capturePage();
        screenshot = { ...image.getSize(), empty: image.isEmpty() };
        if (evidence) {
          await NodeFSP.mkdir(evidence, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(evidence, `annotation-${++sequence}.png`),
            image.toPNG(),
          );
        }
        window.webContents.send(ANNOTATION_CAPTURED_CHANNEL);
      }
      const result = { annotation, crop, submission, scale, screenshot };
      if (resolveResult) {
        const resolve = resolveResult;
        resolveResult = undefined;
        resolve(result);
      } else results.push(result);
    },
  );

  globalThis.annotationFixture = {
    errors,
    async load(scenario) {
      results.length = 0;
      await window.loadFile(fixturePage, { query: { scenario } });
      window.focus();
      window.webContents.focus();
    },
    start(sendEnabled = false) {
      window.webContents.focus();
      window.webContents.send(START_PICK_CHANNEL, undefined, sendEnabled);
    },
    cancel() {
      window.webContents.send(CANCEL_PICK_CHANNEL);
    },
    setSendEnabled(value) {
      window.webContents.send(ANNOTATION_SEND_ENABLED_CHANNEL, value);
    },
    nextResult() {
      if (results.length) return Promise.resolve(results.shift());
      return new Promise((resolve) => {
        resolveResult = resolve;
      });
    },
    resultCount() {
      return results.length;
    },
    copy(text) {
      clipboard.writeText(text);
    },
    preferences() {
      return window.webContents.getLastWebPreferences();
    },
  };
  await globalThis.annotationFixture.load("ordinary");
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
