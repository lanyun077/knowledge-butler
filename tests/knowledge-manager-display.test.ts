// @vitest-environment jsdom
import type { App } from "@modelcontextprotocol/ext-apps";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangePreview } from "../src/manager/changes";
import { StarMap } from "../src/manager/star-map";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const version = "a".repeat(64);
const node = { id: "g0", title: "接口设计", kind: "domain", group: 0, domain: "接口设计", color: "#a8c1ea", summary: "短概况", path: "Wiki/interface.md", version, uri: "obsidian://open?path=trusted" };
function page(offset: number, current = version) {
  const part = (items: unknown[]) => ({ items, total: 1, nextOffset: null });
  return { content: [], structuredContent: { stage: "U2", resourceVersion: "u2-v4", libraryId: "display-test", readAt: new Date().toISOString(), request: { view: "universe", offset },
    sky: { version: current, nodes: part(offset ? [] : [node]), links: part([]), domains: part(offset ? [] : [{ id: "g0", title: node.title, color: node.color }]), nextOffset: offset ? null : 500 } } };
}

it("keeps long before/after text out of the DOM until explicitly expanded", async () => {
  const before = "正文背景".repeat(10000) + "旧结论", after = "正文背景".repeat(10000) + "新结论";
  await act(async () => root.render(createElement(ChangePreview, { before, after })));
  expect(container.textContent!.length).toBeLessThan(1200);
  expect(container.textContent).toContain("新结论");
  await act(async () => { const detail = container.querySelector("details")!; detail.open = true; detail.dispatchEvent(new Event("toggle")); });
  expect(Array.from(container.querySelectorAll("pre")).map(item => item.textContent)).toContain(before);
  await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "收起")!.click());
  expect(container.querySelector("details")!.open).toBe(false);
  expect(container.textContent!.length).toBeLessThan(1200);
});

it("pins graph pages and opens only a trusted node path from its own frame through the local service", async () => {
  const app = { callServerTool: vi.fn(async ({ name, arguments: input }) => name === "learning_manager_open_note" ? { content: [], isError: true } : page(input.offset)) };
  await act(async () => root.render(createElement(StarMap, { app: app as unknown as App, theme: "light" })));
  expect(app.callServerTool.mock.calls[1][0].arguments).toEqual({ view: "universe", offset: 500, version });
  const frame = container.querySelector("iframe")!;
  const reply = vi.spyOn(frame.contentWindow!, "postMessage");
  const send = async (source: MessageEventSource | null, id = "g0") => act(async () => { window.dispatchEvent(new MessageEvent("message", { source, data: { type: "knowledge-star-open", id, uri: "https://untrusted.example" } })); });
  await send(window); await send(frame.contentWindow, "unknown");
  expect(app.callServerTool).toHaveBeenCalledTimes(2);
  await send(frame.contentWindow);
  expect(app.callServerTool).toHaveBeenCalledTimes(3); expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_open_note", arguments: { path: node.path } });
  expect(reply).toHaveBeenLastCalledWith({ type: "knowledge-star-open-result", id: node.id, message: expect.stringContaining("暂时无法打开文章") }, "*");
  await act(async () => root.render(createElement(StarMap, { app: app as unknown as App, theme: "light", focusPath: node.path })));
  expect(container.querySelector("iframe")).not.toBe(frame);
  expect(app.callServerTool).toHaveBeenCalledTimes(3);
});

it("does not mount a mixed graph when a later page has another version", async () => {
  const app = { callServerTool: vi.fn(async ({ arguments: input }) => page(input.offset, input.offset ? "b".repeat(64) : version)) };
  await act(async () => root.render(createElement(StarMap, { app: app as unknown as App, theme: "light" })));
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("知识已变化");
  expect(container.textContent).toContain("通过记录打开文章");
});


it("expands the star workspace and exits with Escape from either frame", async () => {
  const app = { callServerTool: vi.fn(async ({ arguments: input }) => page(input.offset)) };
  await act(async () => root.render(createElement(StarMap, { app: app as unknown as App, theme: "light" })));
  const button = () => container.querySelector<HTMLButtonElement>('.star-toolbar button')!;
  await act(async () => button().click());
  expect(container.querySelector('.star-fullscreen')).not.toBeNull();
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(container.querySelector('.star-fullscreen')).toBeNull(); expect(document.activeElement).toBe(button());
  await act(async () => button().click());
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'knowledge-star-escape' } })));
  expect(container.querySelector('.star-fullscreen')).not.toBeNull();
  await act(async () => window.dispatchEvent(new MessageEvent('message', { source: container.querySelector('iframe')!.contentWindow, data: { type: 'knowledge-star-escape' } })));
  expect(container.querySelector('.star-fullscreen')).toBeNull();
});

it("renders every current node and real link in full view regardless of overview distance", async () => {
  // @ts-expect-error The standalone viewer layout is shared JavaScript.
  const { presentView } = await import('../src/manager/stars/layout.js');
  const view = { nodes: [{ id: 'star', kind: 'domain', group: 0 }, { id: 'planet', kind: 'topic', group: 0 },
    { id: 'moon', kind: 'note', group: 0 }, { id: 'other', kind: 'note', group: 1 }],
    links: [{ id: 'a', source: 'star', target: 'planet', type: '包含' }, { id: 'b', source: 'planet', target: 'moon', type: '包含' },
      { id: 'c', source: 'moon', target: 'other', type: '引用' }] };
  const normal = presentView(view, { collapsed: true, visibleGroups: new Set() });
  expect([...normal.nodes]).toEqual(['star']); expect(normal.links.size).toBe(0);
  const full = presentView(view, { fullView: true, collapsed: true, visibleGroups: new Set() });
  expect([...full.nodes]).toEqual(['star', 'planet', 'moon', 'other']); expect([...full.links]).toEqual(['a', 'b', 'c']);
  expect(full.links.size).toBe(view.links.length);
});


it("updates the theme in place without remounting the graph or rereading pages", async () => {
  const app = { callServerTool: vi.fn(async ({ arguments: input }) => page(input.offset)) };
  await act(async () => root.render(createElement(StarMap, { app: app as unknown as App, theme: "light" })));
  const frame = container.querySelector('iframe')!;
  const send = vi.spyOn(frame.contentWindow!, 'postMessage');
  await act(async () => root.render(createElement(StarMap, { app: app as unknown as App, theme: "dark" })));
  expect(container.querySelector('iframe')).toBe(frame);
  expect(send).toHaveBeenLastCalledWith({ type: 'knowledge-star-theme', theme: 'dark' }, '*');
  expect(app.callServerTool).toHaveBeenCalledTimes(2);
});

it("isolates fullscreen keyboard focus and restores sibling state on exit", async () => {
  const outside = document.createElement('button'); outside.textContent = 'Outside'; container.before(outside);
  const app = { callServerTool: vi.fn(async ({ arguments: input }) => page(input.offset)) };
  try {
    await act(async () => root.render(createElement(StarMap, { app: app as unknown as App, theme: "light" })));
    const frame = container.querySelector('iframe')!;
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    const button = container.querySelector<HTMLButtonElement>('.star-toolbar button')!;
    await act(async () => button.click());
    expect(outside.inert).toBe(true); expect(container.querySelector('[aria-modal="true"]')).not.toBeNull();
    expect(document.activeElement).toBe(button);
    const guards = container.querySelectorAll<HTMLElement>('span[tabindex="0"]');
    guards[0].focus(); expect(send).toHaveBeenLastCalledWith({ type: 'knowledge-star-focus-last' }, '*');
    guards[1].focus(); expect(document.activeElement).toBe(button);
    await act(async () => button.click()); expect(outside.inert).toBeFalsy();
    expect(container.querySelector('iframe')).toBe(frame);
  } finally { outside.remove(); }
});
