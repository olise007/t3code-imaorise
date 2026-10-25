import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import { build } from "vite-plus/pack";
import { _electron as electron } from "playwright-core";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const desktop = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const fixture = NodeURL.fileURLToPath(new URL("./fixtures/annotation-page.html", import.meta.url));
let directory;
let application;
let page;
let cdp;
const pageErrors = [];

NodeTest.before(
  async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-annotation-"));
    const baseline = process.env.T3_ANNOTATION_BASELINE_REVISION;
    if (baseline && !/^[a-f0-9]{40}$/.test(baseline))
      throw new Error("Expected a full baseline revision.");
    for (const [name, entry] of [
      ["preview-pick-preload", "src/preview-pick-preload.ts"],
      ["annotation-main", "scripts/fixtures/annotation-main.mjs"],
    ])
      await build({
        config: false,
        cwd: desktop,
        entry: { [name]: entry },
        outDir: directory,
        clean: false,
        format: "cjs",
        dts: false,
        sourcemap: false,
        outExtensions: () => ({ js: ".cjs" }),
        outputOptions: { codeSplitting: false },
        deps: {
          alwaysBundle: (id) => id === "react-grab" || id.startsWith("react-grab/"),
          neverBundle: (id) => id === "electron" || id.startsWith("node:"),
        },
        plugins: baseline
          ? [
              {
                name: "annotation-regression-baseline",
                load(id) {
                  if (!id.replaceAll("\\", "/").endsWith("/src/preview/PickPreload.ts")) return;
                  return NodeChildProcess.execFileSync(
                    "git",
                    ["show", `${baseline}:apps/desktop/src/preview/PickPreload.ts`],
                    { cwd: desktop, encoding: "utf8" },
                  );
                },
              },
            ]
          : [],
      });
    const profile = NodePath.join(directory, "profile");
    await NodeFSP.mkdir(profile);
    const env = {
      ...process.env,
      T3_ANNOTATION_PROFILE_DIR: profile,
      T3_ANNOTATION_PRELOAD_PATH: NodePath.join(directory, "preview-pick-preload.cjs"),
      T3_ANNOTATION_FIXTURE_PAGE: fixture,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      executablePath: ensureElectronRuntime(),
      args: [NodePath.join(directory, "annotation-main.cjs")],
      env,
      timeout: 30_000,
    });
    page = await application.firstWindow();
    page.setDefaultTimeout(8_000);
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await application.evaluate(() => globalThis.annotationFixture.ready);
    cdp = await page.context().newCDPSession(page);
    const preferences = await application.evaluate(() =>
      globalThis.annotationFixture.preferences(),
    );
    NodeAssert.equal(preferences.contextIsolation, false);
    NodeAssert.equal(preferences.sandbox, true);
    NodeAssert.equal(preferences.nodeIntegration, false);
  },
  { timeout: 120_000 },
);

NodeTest.after(async () => {
  try {
    if (application) await application.close();
  } finally {
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

NodeTest.beforeEach(async () => {
  NodeAssert.deepEqual(pageErrors, []);
  NodeAssert.deepEqual(await application.evaluate(() => globalThis.annotationFixture.errors), []);
});

async function load(scenario) {
  await application.evaluate(
    (_electron, value) => globalThis.annotationFixture.load(value),
    scenario,
  );
  await page.waitForFunction(() => Boolean(window.fixtureState));
}

async function start(sendEnabled = false) {
  await application.evaluate(
    (_electron, value) => globalThis.annotationFixture.start(value),
    sendEnabled,
  );
  await page.waitForFunction(() => document.querySelector("div[data-t3code-annotation-ui]"));
}

// CDP can inspect a closed shadow root without modifying the production preload.
// All user actions below still go through real mouse and keyboard input.
async function uiNode(attribute, value) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const visit = (node, inOverlay = false) => {
    const attrs = Object.fromEntries(
      Array.from({ length: (node.attributes?.length ?? 0) / 2 }, (_, index) => [
        node.attributes[index * 2],
        node.attributes[index * 2 + 1],
      ]),
    );
    const overlay = inOverlay || Object.hasOwn(attrs, "data-t3code-annotation-ui");
    if (overlay && attrs[attribute] === value) return node;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const found = visit(child, overlay);
      if (found) return found;
    }
    return null;
  };
  const found = visit(root);
  NodeAssert.ok(found, `Annotation control ${attribute}=${value} exists`);
  return found;
}

async function uiPoint(attribute, value) {
  const node = await uiNode(attribute, value);
  const { object } = await cdp.send("DOM.resolveNode", { nodeId: node.nodeId });
  try {
    // Like a locator click, wait for layout to settle before sampling coordinates.
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function () {
        return new Promise((resolve) => {
          const deadline = performance.now() + 8000;
          let previous;
          const measure = () => {
            const rect = this.getBoundingClientRect();
            const current = [rect.x, rect.y, rect.width, rect.height];
            if (previous && current.every((value, index) => value === previous[index])) {
              resolve(true);
              return;
            }
            if (performance.now() >= deadline) {
              resolve(false);
              return;
            }
            previous = current;
            requestAnimationFrame(measure);
          };
          requestAnimationFrame(measure);
        });
      }`,
      awaitPromise: true,
      returnByValue: true,
    });
    NodeAssert.equal(result.value, true, `Annotation control ${attribute}=${value} stopped moving`);
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
  }
  const { model } = await cdp.send("DOM.getBoxModel", { nodeId: node.nodeId });
  const [x1, y1, x2, , , y3] = model.content;
  NodeAssert.ok(model.width > 0 && model.height > 0, "Annotation control is visible");
  return { x: (x1 + x2) / 2, y: (y1 + y3) / 2 };
}

async function clickUi(attribute, value) {
  const point = await uiPoint(attribute, value);
  await page.mouse.click(point.x, point.y);
}

async function commentValue() {
  const node = await uiNode("placeholder", "Describe the change…");
  const { object } = await cdp.send("DOM.resolveNode", { nodeId: node.nodeId });
  try {
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function () { return this.value; }",
      returnByValue: true,
    });
    return result.value;
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
  }
}

// The host may still focus a toolbar button. A new redirect also lets the old
// preload reach the lost-comment assertion when it reproduces the focus trap.
// Read focus directly: the preload intentionally suppresses page focus listeners.
async function waitForCommentFocus(previousRedirects) {
  const node = await uiNode("placeholder", "Describe the change…");
  const { object } = await cdp.send("DOM.resolveNode", { nodeId: node.nodeId });
  try {
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function (previousRedirects) {
        return new Promise((resolve) => {
          const deadline = performance.now() + 8000;
          const ready = () => {
            const active = this.getRootNode().activeElement;
            if (active === this || window.fixtureState.focusRedirects > previousRedirects) {
              resolve(true);
              return;
            }
            if (performance.now() >= deadline) {
              resolve({
                active: active?.outerHTML,
                pageActive: document.activeElement?.outerHTML.slice(0, 500),
                commentVisible: this.checkVisibility(),
                redirects: window.fixtureState.focusRedirects,
              });
              return;
            }
            requestAnimationFrame(ready);
          };
          ready();
        });
      }`,
      arguments: [{ value: previousRedirects }],
      awaitPromise: true,
      returnByValue: true,
    });
    NodeAssert.equal(result.value, true, `Comment focus: ${JSON.stringify(result.value)}`);
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
  }
}

async function chooseTarget(id) {
  const redirects = await page.evaluate(() => window.fixtureState.focusRedirects);
  const box = await page.locator(`#${id}`).boundingBox();
  NodeAssert.ok(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitForCommentFocus(redirects);
}

async function marqueeTarget(id) {
  const redirects = await page.evaluate(() => window.fixtureState.focusRedirects);
  await clickUi("title", "Draw a region or marquee-select elements (R)");
  const box = await page.locator(`#${id}`).boundingBox();
  NodeAssert.ok(box);
  await page.mouse.move(box.x - 5, box.y - 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 5, box.y + box.height + 5, { steps: 4 });
  await page.mouse.up();
  await waitForCommentFocus(redirects);
}

async function chooseDialog(id) {
  const redirects = await page.evaluate(() => window.fixtureState.focusRedirects);
  const box = await page.locator(`#${id}`).boundingBox();
  NodeAssert.ok(box);
  await page.mouse.click(box.x + box.width - 15, box.y + box.height - 15);
  await waitForCommentFocus(redirects);
}

async function previewZeroOpacity() {
  await clickUi("aria-label", "Expand annotation editor");
  const range = await uiNode("type", "range");
  await cdp.send("DOM.scrollIntoViewIfNeeded", { nodeId: range.nodeId });
  await clickUi("type", "range");
  await page.keyboard.press("Home");
  // Let placement reconciliation scheduled by the style mutation finish.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
}

async function setSendEnabled(enabled) {
  const oldTitle = enabled
    ? "Attach annotation and screenshot (Enter)"
    : "Attach annotation and screenshot (Enter). Send with Cmd/Ctrl+Enter.";
  const newTitle = enabled
    ? "Attach annotation and screenshot (Enter). Send with Cmd/Ctrl+Enter."
    : "Attach annotation and screenshot (Enter)";
  const node = await uiNode("title", oldTitle);
  const { object } = await cdp.send("DOM.resolveNode", { nodeId: node.nodeId });
  const changed = cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function (title) {
      return new Promise((resolve) => {
        if (this.title === title) return resolve(true);
        const observer = new MutationObserver(() => {
          if (this.title !== title) return;
          observer.disconnect();
          resolve(true);
        });
        observer.observe(this, { attributes: true, attributeFilter: ["title"] });
      });
    }`,
    arguments: [{ value: newTitle }],
    awaitPromise: true,
    returnByValue: true,
  });
  try {
    await application.evaluate(
      (_electron, value) => globalThis.annotationFixture.setSendEnabled(value),
      enabled,
    );
    await changed;
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
  }
}

async function attach() {
  await clickUi("title", "Attach annotation and screenshot (Enter)");
  return application.evaluate(() => globalThis.annotationFixture.nextResult());
}

async function assertClosed() {
  await page.waitForFunction(() => !document.querySelector("div[data-t3code-annotation-ui]"));
  NodeAssert.equal(await page.locator("html").getAttribute("data-t3code-annotation-tool"), null);
  NodeAssert.deepEqual(pageErrors, []);
}

NodeTest.test(
  "selecting a modal excludes the annotation host from captured page markup",
  { timeout: 25_000 },
  async () => {
    await load("native");
    await start();
    await chooseDialog("native");
    await page.keyboard.type("Change this modal");
    const result = await attach();
    NodeAssert.equal(result.annotation.elements[0].element.tagName, "dialog");
    NodeAssert.ok(
      !result.annotation.elements[0].element.htmlPreview.includes("data-t3code-annotation-ui"),
    );
    await assertClosed();
  },
);

NodeTest.test("retains typed comments in a focus-trapped modal", { timeout: 25_000 }, async () => {
  await load("scripted");
  await start();
  await chooseTarget("scripted-target");
  await clickUi("placeholder", "Describe the change…");
  await page.keyboard.type("Change the customer details here");
  const result = await attach();
  NodeAssert.equal(
    result.annotation.comment,
    "Change the customer details here",
    "typed annotation comment must survive a website focus trap",
  );
  NodeAssert.equal(result.annotation.elements.length, 1);
  NodeAssert.equal(result.submission, "attach");
  NodeAssert.ok(result.screenshot.width > 0 && !result.screenshot.empty);
  NodeAssert.equal(await page.locator("#scripted").isVisible(), true);
  NodeAssert.deepEqual(await page.evaluate(() => window.fixtureState), {
    submissions: 0,
    dismissals: 0,
    leakedKeys: [],
    focusRedirects: 0,
  });
  await assertClosed();
});

for (const [scenario, target] of [
  ["ordinary", "background-target"],
  ["native", "native-target"],
  ["nested", "second-target"],
  ["scrolling", "scripted-target"],
]) {
  NodeTest.test(`selects and types on ${scenario} pages`, { timeout: 25_000 }, async () => {
    await load(scenario);
    await page.locator(`#${target}`).scrollIntoViewIfNeeded();
    await start();
    await chooseTarget(target);
    await page.keyboard.type(`Comment for ${scenario}`);
    NodeAssert.equal(await commentValue(), `Comment for ${scenario}`);
    await page.keyboard.press("Enter");
    const result = await application.evaluate(() => globalThis.annotationFixture.nextResult());
    NodeAssert.equal(result.annotation.comment, `Comment for ${scenario}`);
    NodeAssert.ok(result.annotation.elements[0].element.htmlPreview.includes(target));
    NodeAssert.ok(result.crop.width > 0 && result.crop.height > 0);
    NodeAssert.equal(await page.evaluate(() => window.fixtureState.submissions), 0);
    if (scenario === "native" || scenario === "nested")
      NodeAssert.equal(
        await page
          .locator(scenario === "nested" ? "#second" : "#native")
          .evaluate((element) => element.open),
        true,
      );
    await assertClosed();
  });
}

NodeTest.test(
  "preserves editing, paste, Tab and send permission changes",
  { timeout: 25_000 },
  async () => {
    await load("scripted");
    await start(true);
    await chooseTarget("scripted-target");
    await page.keyboard.type("first");
    await page.keyboard.press("Shift+Enter");
    await application.evaluate(() => globalThis.annotationFixture.copy("pasted text"));
    await page.keyboard.press("Control+V");
    NodeAssert.equal(await commentValue(), "first\npasted text");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("!");
    NodeAssert.equal(await commentValue(), "first\npasted text!");
    await setSendEnabled(false);
    await page.keyboard.press("Control+Enter");
    NodeAssert.equal(
      await application.evaluate(() => globalThis.annotationFixture.resultCount()),
      0,
    );
    await setSendEnabled(true);
    await page.keyboard.press("Control+Enter");
    const result = await application.evaluate(() => globalThis.annotationFixture.nextResult());
    NodeAssert.equal(result.submission, "send");
    NodeAssert.equal(result.annotation.comment, "first\npasted text!");
    NodeAssert.equal(await page.evaluate(() => window.fixtureState.submissions), 0);
    await assertClosed();
  },
);

NodeTest.test(
  "IME composition edits the comment without submitting the website form",
  { timeout: 25_000 },
  async () => {
    await load("scripted");
    await start();
    await chooseTarget("scripted-target");
    await cdp.send("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 });
    NodeAssert.equal(
      await application.evaluate(() => globalThis.annotationFixture.resultCount()),
      0,
    );
    await cdp.send("Input.insertText", { text: "日本語" });
    NodeAssert.equal(await commentValue(), "日本語");
    const result = await attach();
    NodeAssert.equal(result.annotation.comment, "日本語");
    NodeAssert.equal(await page.evaluate(() => window.fixtureState.submissions), 0);
    await assertClosed();
  },
);

NodeTest.test(
  "closing a modal preserves the draft for a page selection",
  { timeout: 25_000 },
  async () => {
    await load("scripted");
    await start();
    await chooseTarget("scripted-target");
    await page.keyboard.type("Keep after close");
    await page.evaluate(() => window.closeFixtureModal());
    await page.waitForFunction(() =>
      document.querySelector("html > div[data-t3code-annotation-ui]")?.matches(":popover-open"),
    );
    await chooseTarget("background-target");
    NodeAssert.equal((await attach()).annotation.comment, "Keep after close");
    await assertClosed();
  },
);

NodeTest.test(
  "keeps the draft when a modal is replaced, and cleans up repeated sessions",
  { timeout: 25_000 },
  async () => {
    await load("scripted");
    await start();
    await chooseTarget("scripted-target");
    await page.keyboard.type("Keep this comment");
    await page.evaluate(() => window.replaceFixtureModal());
    await page.waitForFunction(() =>
      document.querySelector("#scripted > div[data-t3code-annotation-ui]"),
    );
    await chooseTarget("replacement-target");
    await clickUi("placeholder", "Describe the change…");
    NodeAssert.equal(await commentValue(), "Keep this comment");
    NodeAssert.equal((await attach()).annotation.comment, "Keep this comment");
    await assertClosed();
    await start();
    await chooseTarget("replacement-target");
    await page.keyboard.press("Escape");
    const result = await application.evaluate(() => globalThis.annotationFixture.nextResult());
    NodeAssert.equal(result.annotation, null);
    await assertClosed();
    NodeAssert.equal(await page.locator("#scripted").isVisible(), true);
    NodeAssert.equal(await page.evaluate(() => window.fixtureState.dismissals), 0);
    await page.locator("#replacement-field").fill("Website input still works");
    NodeAssert.equal(
      await page.locator("#replacement-field").inputValue(),
      "Website input still works",
    );
  },
);

NodeTest.test(
  "reparents for newly opened native dialogs and Escape leaves the modal open",
  { timeout: 25_000 },
  async () => {
    await load("native");
    await start();
    await chooseTarget("native-target");
    await page.keyboard.type("Draft across modals");
    await page.evaluate(() => window.openSecondModal());
    await page.waitForFunction(() =>
      document.querySelector("#second > div[data-t3code-annotation-ui]")?.matches(":popover-open"),
    );
    await chooseTarget("second-target");
    await clickUi("placeholder", "Describe the change…");
    NodeAssert.equal(await commentValue(), "Draft across modals");
    await page.keyboard.press("Escape");
    await application.evaluate(() => globalThis.annotationFixture.nextResult());
    await assertClosed();
    NodeAssert.equal(await page.locator("#second").evaluate((element) => element.open), true);
    NodeAssert.equal(await page.evaluate(() => window.fixtureState.dismissals), 0);
  },
);

NodeTest.test(
  "marquee selects visible modal contents, excluding covered background elements",
  { timeout: 25_000 },
  async () => {
    await load("scripted");
    await start();
    await marqueeTarget("scripted-target");
    await page.keyboard.type("Only the visible target");
    const result = await attach();
    NodeAssert.equal(result.annotation.elements.length, 1);
    NodeAssert.ok(result.annotation.elements[0].element.htmlPreview.includes("scripted-target"));
    NodeAssert.ok(!JSON.stringify(result.annotation.elements).includes("background-target"));
    await assertClosed();
  },
);

NodeTest.test(
  "drawing, erasing and style controls work above a transformed modal",
  { timeout: 25_000 },
  async () => {
    await load("scrolling");
    await page.locator("#scripted-target").scrollIntoViewIfNeeded();
    await start();
    await clickUi("title", "Draw freehand (D)");
    await page.mouse.move(900, 400);
    await page.mouse.down();
    await page.mouse.move(950, 440, { steps: 5 });
    await page.mouse.up();
    await clickUi("title", "Remove an annotation target (E)");
    await page.mouse.click(925, 420);
    await clickUi("title", "Select elements (V)");
    await chooseTarget("scripted-target");
    await clickUi("aria-label", "Expand annotation editor");
    await clickUi("placeholder", "16");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("24");
    NodeAssert.equal(
      await page.locator("#scripted-target").evaluate((element) => element.style.fontSize),
      "24px",
    );
    await clickUi("placeholder", "Describe the change…");
    await page.keyboard.type("Larger text");
    const result = await attach();
    NodeAssert.equal(result.annotation.strokes.length, 0);
    NodeAssert.ok(
      result.annotation.styleChanges.some(
        (change) => change.property === "font-size" && change.value === "24px",
      ),
    );
    await assertClosed();
    NodeAssert.equal(
      await page.locator("#scripted-target").evaluate((element) => element.style.fontSize),
      "",
    );
  },
);

NodeTest.test(
  "navigation and explicit cancellation leave no annotation host or input interception",
  { timeout: 25_000 },
  async () => {
    await load("native");
    await start();
    await chooseTarget("native-target");
    await application.evaluate(() => globalThis.annotationFixture.cancel());
    await assertClosed();
    await start();
    await load("ordinary");
    await assertClosed();
    await start();
    await chooseTarget("background-target");
    await page.keyboard.type("Fresh session after navigation");
    NodeAssert.equal((await attach()).annotation.comment, "Fresh session after navigation");
    await assertClosed();
  },
);

for (const scenario of ["nonmodal-native", "nonmodal-scripted"]) {
  NodeTest.test(
    `selects visible page content beside ${scenario} dialogs`,
    { timeout: 25_000 },
    async () => {
      await load(scenario);
      const dialog = page.locator(scenario === "nonmodal-native" ? "#native" : "#scripted");
      for (const select of [chooseTarget, marqueeTarget]) {
        await start();
        await select("background-target");
        await page.keyboard.type("Change the page outside the panel");
        const result = await attach();
        NodeAssert.equal(result.annotation.elements.length, 1);
        NodeAssert.ok(
          result.annotation.elements[0].element.htmlPreview.includes("background-target"),
        );
        NodeAssert.equal(result.annotation.comment, "Change the page outside the panel");
        await assertClosed();
        NodeAssert.equal(await dialog.isVisible(), true);
      }
    },
  );
}

for (const scenario of ["scripted", "native"]) {
  NodeTest.test(
    `keeps intentional zero-opacity edits on ${scenario} dialogs`,
    { timeout: 25_000 },
    async () => {
      await load(scenario);
      await start();
      await chooseDialog(scenario);
      await page.keyboard.type("Keep the transparent dialog");
      await previewZeroOpacity();
      NodeAssert.equal(
        await page.locator(`#${scenario}`).evaluate((element) => element.style.opacity),
        "0",
      );
      await clickUi("placeholder", "Describe the change…");
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" and this comment");
      const result = await attach();
      NodeAssert.equal(result.annotation.comment, "Keep the transparent dialog and this comment");
      NodeAssert.equal(result.annotation.elements.length, 1);
      NodeAssert.ok(
        result.annotation.styleChanges.some(
          (change) => change.property === "opacity" && change.value === "0",
        ),
      );
      await assertClosed();
      NodeAssert.equal(
        await page.locator(`#${scenario}`).evaluate((element) => element.style.opacity),
        "",
      );

      for (let session = 0; session < 3; session++) {
        await start();
        await chooseDialog(scenario);
        await previewZeroOpacity();
        NodeAssert.equal(
          await page.locator(`#${scenario}`).evaluate((element) => element.style.opacity),
          "0",
        );
        await page.keyboard.press("Escape");
        NodeAssert.equal(
          (await application.evaluate(() => globalThis.annotationFixture.nextResult())).annotation,
          null,
        );
        await assertClosed();
        NodeAssert.equal(
          await page.locator(`#${scenario}`).evaluate((element) => element.style.opacity),
          "",
        );
        NodeAssert.equal(await page.locator(`#${scenario}`).isVisible(), true);
        NodeAssert.equal(await page.evaluate(() => window.fixtureState.dismissals), 0);
      }
    },
  );
}

for (const line of ["horizontal-line", "vertical-line"]) {
  NodeTest.test(
    `selects a visible ancestor when clicking the SVG ${line}`,
    { timeout: 25_000 },
    async () => {
      await load("svg");
      NodeAssert.equal(
        await page.locator(`#${line}`).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id;
        }),
        line,
      );
      await start();
      await chooseTarget(line);
      await page.keyboard.type(`Annotate ${line}`);
      const result = await attach();
      NodeAssert.equal(result.annotation.elements.length, 1);
      NodeAssert.equal(result.annotation.elements[0].element.tagName, "svg");
      NodeAssert.ok(result.annotation.elements[0].element.htmlPreview.includes("line-chart"));
      NodeAssert.equal(result.annotation.comment, `Annotate ${line}`);
      NodeAssert.ok(result.crop.width > 0 && result.crop.height > 0 && !result.screenshot.empty);
      await assertClosed();
    },
  );
}
