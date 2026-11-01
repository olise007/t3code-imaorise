import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { chromium } from "playwright-core";

const webRoot = NodeURL.fileURLToPath(new URL("../../web/", import.meta.url));
const requireWeb = NodeModule.createRequire(new URL("../../web/package.json", import.meta.url));
const { createServer } = await import(requireWeb.resolve("vite"));
const { default: react } = await import(requireWeb.resolve("@vitejs/plugin-react"));
const server = await createServer({
  configFile: false,
  appType: "mpa",
  plugins: [react()],
  optimizeDeps: { entries: ["test-fixtures/upstream-performance.html"] },
  root: webRoot,
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  NodeAssert.ok(address && typeof address !== "string");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/test-fixtures/upstream-performance.html`);
  await page.getByText("single line", { exact: true }).waitFor();
  const editor = page.getByTestId("composer-editor");
  await editor.fill("a long prompt that wraps ".repeat(6));
  await page.getByText("multiline", { exact: true }).waitFor();
  await editor.fill("short");
  await page.getByText("single line", { exact: true }).waitFor();
  await page.evaluate(() => {
    const scroll = Element.prototype.scrollIntoView;
    window.scrollCalls = 0;
    Element.prototype.scrollIntoView = function (...args) {
      window.scrollCalls++;
      return scroll.apply(this, args);
    };
  });
  await page.getByText("thread-2", { exact: true }).click();
  NodeAssert.equal(
    await page.evaluate(() => window.scrollCalls),
    0,
    "pointer activation must not force a scroll",
  );
  await page.evaluate(() => document.getElementById("row-40").focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  NodeAssert.equal(
    await page.evaluate(() => window.scrollCalls),
    1,
    "keyboard activation must reveal the row",
  );
  NodeAssert.ok(
    await page.evaluate(() => {
      const row = document.getElementById("row-40").getBoundingClientRect();
      const list = document.querySelector("ul").getBoundingClientRect();
      return row.top >= list.top && row.bottom <= list.bottom;
    }),
    "keyboard target should be visible",
  );
  NodeAssert.deepEqual(errors, []);
  console.log(
    "PASS: composer wrapping, pointer activation without scrolling, and keyboard row reveal",
  );
} finally {
  await browser?.close();
  await server.close();
}
