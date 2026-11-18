// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";

vi.mock("3d-force-graph", () => ({ default: () => { throw new Error("WebGL unavailable"); } }));

it("opens a leaf theme immediately, reopens the current star, and reports repeated open requests beside the preview", async () => {
  document.documentElement.innerHTML = (await readFile("src/manager/stars/shell.html", "utf8")).replace(/<!doctype html>/i, "");
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const send = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  // @ts-expect-error The standalone viewer is shared JavaScript.
  await import("../src/manager/stars/viewer.js");
  const node = { id: "g0", kind: "domain", group: 0, title: "普通笔记", domain: "普通笔记", color: "#abcdef", summary: "短概况", path: "Wiki/plain.md", uri: "obsidian://open?path=plain", degree: 0 };
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "knowledge-star-data", theme: "light", data: { nodes: [node], links: [], domains: [{ id: node.id, title: node.title, color: node.color }] } } }));
  const click = (id: string) => document.getElementById(id)!.click();
  try {
    document.querySelector<HTMLButtonElement>(".domain-row")!.click();
    expect(document.getElementById("inspector")!.hidden).toBe(false);
    expect(document.getElementById("detail-title")!.textContent).toBe("普通笔记");
    click("open-note");
    expect(send).toHaveBeenLastCalledWith({ type: "knowledge-star-open", id: "g0" }, "*");
    expect(document.getElementById("open-status")!.textContent).toContain("正在请求打开");
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "knowledge-star-open-result", id: "g0", message: "暂时无法打开文章" } }));
    expect(document.getElementById("open-status")!.textContent).toBe("暂时无法打开文章");
    click("close"); click("open-topic");
    expect(document.getElementById("inspector")!.hidden).toBe(false);
    click("open-note");
    expect(document.getElementById("open-status")!.textContent).toContain("正在请求打开");
    // Selecting the current star through a direct relation must not silently do nothing.
    // Reuse the real search navigation, which calls the same canvas navigation handler.
    const search = document.getElementById("search") as HTMLInputElement;
    search.value = "普通"; search.dispatchEvent(new Event("input"));
    document.querySelector<HTMLButtonElement>("#results button")!.click();
    expect(document.getElementById("open-status")!.textContent).toBe("");
    expect(document.getElementById("inspector")!.hidden).toBe(false);
  } finally {
    window.dispatchEvent(new Event("pagehide")); errors.mockRestore(); send.mockRestore(); vi.unstubAllGlobals();
  }
});
