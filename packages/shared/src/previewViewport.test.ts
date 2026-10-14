import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_VIEWPORT_PRESETS,
  PREVIEW_VIEWPORT_PRESET_GROUPS,
  resolvePreviewViewport,
} from "./previewViewport.ts";

describe("previewViewport", () => {
  it("resolves fill and exact freeform viewports", () => {
    expect(resolvePreviewViewport({ mode: "fill" })).toEqual({ _tag: "fill" });
    expect(resolvePreviewViewport({ mode: "freeform", width: 1024, height: 768 })).toEqual({
      _tag: "freeform",
      width: 1024,
      height: 768,
    });
  });

  it("resolves device presets in either orientation", () => {
    expect(resolvePreviewViewport({ mode: "preset", preset: "iphone-12-pro" })).toEqual({
      _tag: "preset",
      width: 390,
      height: 844,
      presetId: "iphone-12-pro",
    });
    expect(
      resolvePreviewViewport({
        mode: "preset",
        preset: "iphone-12-pro",
        orientation: "landscape",
      }),
    ).toEqual({
      _tag: "preset",
      width: 844,
      height: 390,
      presetId: "iphone-12-pro",
    });
  });

  it("puts desktop sizes before Chrome's standard device catalog", () => {
    expect(PREVIEW_VIEWPORT_PRESETS.map((preset) => preset.label)).toEqual([
      "Desktop 1920×1080",
      "Desktop 1440×900",
      "Laptop 1366×768",
      "Laptop 1280×800",
      "iPhone SE",
      "iPhone XR",
      "iPhone 12 Pro",
      "iPhone 14 Pro Max",
      "Pixel 7",
      "Samsung Galaxy S8+",
      "Samsung Galaxy S20 Ultra",
      "iPad Mini",
      "iPad Air",
      "iPad Pro",
      "Surface Pro 7",
      "Surface Duo",
      "Galaxy Z Fold 5",
      "Asus Zenbook Fold",
      "Samsung Galaxy A51/71",
      "Nest Hub",
      "Nest Hub Max",
    ]);
  });

  it.each([
    ["desktop-1920x1080", 1920, 1080],
    ["desktop-1440x900", 1440, 900],
    ["laptop-1366x768", 1366, 768],
    ["laptop-1280x800", 1280, 800],
  ] as const)("resolves restored preset %s", (preset, width, height) => {
    expect(resolvePreviewViewport({ mode: "preset", preset })).toEqual({
      _tag: "preset",
      presetId: preset,
      width,
      height,
    });
  });

  it("groups every preset once under its device category", () => {
    expect(PREVIEW_VIEWPORT_PRESET_GROUPS.map((group) => group.category)).toEqual([
      "Desktop",
      "Tablet",
      "Phone",
    ]);
    const grouped = PREVIEW_VIEWPORT_PRESET_GROUPS.flatMap((group) => group.presets);
    expect(new Set(grouped.map((preset) => preset.id)).size).toBe(PREVIEW_VIEWPORT_PRESETS.length);
    expect(grouped).toHaveLength(PREVIEW_VIEWPORT_PRESETS.length);
  });
});
