// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { PerspectiveCamera, Vector3 } from "three";
import { expect, it, vi } from "vitest";

vi.mock("3d-force-graph", () => ({ default: () => (root: HTMLElement) => {
  const canvas = document.createElement("canvas"); root.append(canvas);
  canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 600 }) as DOMRect;
  const camera = new PerspectiveCamera(50, 400 / 600, 1, 10000);
  camera.position.z = 400; camera.updateMatrixWorld();
  const controls = { target: new Vector3(), addEventListener() {}, removeEventListener() {} };
  let createObject: (node: any) => any;
  const graph: any = new Proxy({}, { get: (_, key) => {
    if (key === "camera") return () => camera;
    if (key === "controls") return () => controls;
    if (key === "renderer") return () => ({ domElement: canvas, setPixelRatio() {} });
    if (key === "nodeThreeObject") return (create: typeof createObject) => { createObject = create; return graph; };
    if (key === "graphData") return (data: { nodes: any[] }) => {
      for (const node of data.nodes) {
        const object = createObject(node); object.position.set(node.x, node.y, node.z); object.updateMatrixWorld(true);
      }
      return graph;
    };
    return () => graph;
  } });
  return graph;
} }));

it("picks the visible sphere on the first click without a hover frame, accounting for canvas offset and size, and ignores drags", async () => {
  document.documentElement.innerHTML = (await readFile("src/manager/stars/shell.html", "utf8")).replace(/<!doctype html>/i, "");
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const send = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  // @ts-expect-error The standalone viewer is shared JavaScript.
  await import("../src/manager/stars/viewer.js");
  const node = { id: "g0", kind: "domain", group: 0, title: "普通笔记", domain: "普通笔记", color: "#abcdef", summary: "短概况", path: "Wiki/plain.md", uri: "obsidian://open?path=plain", degree: 0 };
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "knowledge-star-data", theme: "light", data: { nodes: [node], links: [], domains: [{ id: node.id, title: node.title, color: node.color }] } } }));
  try {
    document.querySelector<HTMLButtonElement>(".domain-row")!.click();
    document.getElementById("close")!.click();
    const canvas = document.querySelector("canvas")!;
    canvas.addEventListener("pointerup", event => { event.preventDefault(); event.stopPropagation(); });
    const pointer = (type: string, x = 300, y = 350, button = 0) => canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button }));
    pointer("pointerdown"); pointer("pointerup");
    expect(document.getElementById("inspector")!.hidden).toBe(false);
    expect(document.getElementById("detail-title")!.textContent).toBe(node.title);
    document.getElementById("close")!.click();
    pointer("pointerdown"); pointer("pointermove", 350); pointer("pointerup");
    expect(document.getElementById("inspector")!.hidden).toBe(true);
    pointer("pointerdown", 300, 350, 1); pointer("pointerup", 300, 350, 1);
    expect(document.getElementById("inspector")!.hidden).toBe(true);
    pointer("pointerdown"); pointer("pointerup");
    pointer("pointerdown", 102, 52); pointer("pointerup", 102, 52);
    expect(document.getElementById("inspector")!.hidden).toBe(true);
  } finally {
    window.dispatchEvent(new Event("pagehide")); send.mockRestore(); vi.unstubAllGlobals();
  }
});
