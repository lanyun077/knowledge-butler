// @vitest-environment jsdom
import type { App } from "@modelcontextprotocol/ext-apps";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeWorkspace } from "../src/manager/knowledge";
import { OrganizeKnowledge } from "../src/manager/organize";
import { managerSnapshot, managerInput } from "../src/knowledge-manager-contract";

const charts = vi.hoisted(() => ({ mindmap: vi.fn(), destroy: vi.fn(), fit: vi.fn() }));
vi.mock("../src/manager/charts", () => ({ drawMindmap: charts.mindmap }));
vi.mock("../src/manager/star-map", () => ({ StarMap: () => createElement("div", { "data-star-map": true }) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  sessionStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); charts.mindmap.mockReturnValue({ destroy: charts.destroy, fit: charts.fit });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const page = <T,>(items: T[]) => ({ items, total: items.length, nextOffset: null });
const version = "a".repeat(64);
const topic = { path: "Wiki/topic.md", title: "接口知识", summary: "版本与演进", version, openUri: "obsidian://open?path=C%3A%5CVault%5CWiki%5Ctopic.md", nextOffset: null,
  notes: [], links: [], outline: [], organized: { items: page([
    { id: "a", title: "版本", group: "接口", summary: "保留适用条件", evidence: "出处：材料 · 版本：old-version" },
    { id: "b", title: "演进", group: "接口", summary: "演进条件", evidence: "历史出处" },
  ]), relations: page([{ from: "a", to: "b", type: "应用于" as const, inferred: true, evidence: "推断：共同接口" }]), endpoints: [], invalidRelations: 0 } };
function button(label: string) {
  const value = Array.from(container.querySelectorAll("button")).find(button => button.textContent === label || button.getAttribute("aria-label") === label);
  expect(value, label).toBeTruthy(); return value!;
}
async function click(label: string) { await act(async () => button(label).click()); }

describe("knowledge workspace", () => {
  it("restores an unfinished selection after remount and isolates another library", async () => {
    const app = { callServerTool: vi.fn(async () => ({ content: [], structuredContent: managerSnapshot.parse({ stage: "U2", resourceVersion: "u2-v4", libraryId: "one", readAt: "now", request: managerInput.parse({ view: "projects" }), management: {
      view: "projects", page: page([{ path: "Projects/a.md", title: "A", category: "projects", version, excerpt: "", reuse: { kind: "context", savedVersion: "unrecorded" }, relatedPlans: [] }]),
    } }) })) } as unknown as App;
    const render = (libraryId: string) => act(async () => root.render(createElement(OrganizeKnowledge, { key: libraryId, app, libraryId, close: vi.fn(), prepare: vi.fn() })));
    await render("one"); await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => { const input = container.querySelector<HTMLTextAreaElement>("#knowledge-task")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "继续这份整理"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await render("two"); expect(container.querySelector<HTMLTextAreaElement>("#knowledge-task")!.value).toBe("");
    expect(container.textContent).toContain("已选 0 项");
    await render("one"); expect(container.querySelector<HTMLTextAreaElement>("#knowledge-task")!.value).toBe("继续这份整理");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    await click("清空本次选择"); await render("two"); await render("one");
    expect(container.querySelector<HTMLTextAreaElement>("#knowledge-task")!.value).toBe(""); expect(container.textContent).toContain("已选 0 项");
  });
  it("escapes Markdown-supplied labels and IDs before building Markmap HTML", async () => {
    const { mindmapData } = await vi.importActual<typeof import("../src/manager/charts")>("../src/manager/charts");
    const value = mindmapData({ title: '<img src=x onerror="evil()">', items: [{ id: 'a" onclick="evil()', title: '<script>evil()</script>', group: '<b>组</b>', summary: "", evidence: "" }], relations: [] });
    const html = JSON.stringify(value);
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img"); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&quot;");
  });
  it("switches the same items locally, preserves evidence, and destroys charts on view/theme/unmount", async () => {
    const app = { callServerTool: vi.fn(), sendMessage: vi.fn(), openLink: vi.fn(async () => ({})) } as unknown as App;
    const render = (theme: string) => act(async () => root.render(createElement(KnowledgeWorkspace, { topic, app, theme, disabled: false, offset: 0, onPage: vi.fn(), organize: vi.fn() })));
    await render("light"); expect(container.querySelector("[data-star-map]")).not.toBeNull();
    expect(container.querySelector(".filter")).toBeNull();
    await click("Markdown");
    await click("版本接口"); expect(container.textContent).toContain("old-version");
    await act(async () => { const detail = container.querySelector("details")!; detail.open = true; detail.dispatchEvent(new Event("toggle")); });
    await click("版本 · 应用于 · 演进（推断）"); expect(container.textContent).toContain("推断：共同接口");
    await click("思维导图"); expect(charts.destroy).not.toHaveBeenCalled(); expect(charts.mindmap).toHaveBeenCalledTimes(1);
    expect(charts.mindmap.mock.calls[0][1].items).toHaveLength(2);
    await render("dark"); expect(charts.destroy).toHaveBeenCalledTimes(1);
    await click("Markdown"); expect(charts.destroy).toHaveBeenCalledTimes(2); expect(container.querySelector(".knowledge-chart")).toBeNull();
    expect(container.textContent).toContain("保留适用条件"); expect(app.callServerTool).not.toHaveBeenCalled(); expect(app.sendMessage).not.toHaveBeenCalled();
    await click("三维星图"); await act(async () => root.unmount()); expect(charts.destroy).toHaveBeenCalledTimes(2);
    root = createRoot(container);
  });

  it("reports an open request rather than claiming Obsidian launched and keeps an empty topic usable", async () => {
    const app = { openLink: vi.fn(async () => ({})) } as unknown as App;
    const empty = { ...topic, organized: { ...topic.organized, items: page([]), relations: page([]) } };
    await act(async () => root.render(createElement(KnowledgeWorkspace, { topic: empty, app, theme: "light", disabled: false, offset: 0, onPage: vi.fn(), organize: vi.fn() })));
    await click("Markdown"); expect(container.textContent).toContain("暂无可展示条目");
    await click("在 Obsidian 打开"); expect(app.openLink).toHaveBeenCalledWith({ url: topic.openUri }); expect(container.textContent).toContain("已请求在 Obsidian 打开");
    await click("Markdown"); expect(container.textContent).toContain("完整正文");
  });

  it("keeps paged project/learning selections and exclusions in the explicit chat handoff without writing", async () => {
    const prepare = vi.fn(), close = vi.fn();
    const app = { callServerTool: vi.fn(async ({ name, arguments: args }) => {
      if (name === "learning_knowledge_collect") return { content: [{ type: "text", text: JSON.stringify({ sources: { items: [{ path: "Inbox/linked.md", title: "关联", selected: false }], total: 3 }, unavailable: { items: [] }, nextOffset: null }) }] };
      const path = args.view === "projects" ? `Projects/project-${args.offset ?? 0}.md` : "Learning/goal.md";
      return { content: [], structuredContent: managerSnapshot.parse({ stage: "U2", resourceVersion: "u2-v4", libraryId: "test", readAt: "now", request: managerInput.parse(args), management: {
        view: args.view, page: { items: [{ path, title: path, category: args.view, version, excerpt: "短摘要", reuse: { kind: "context", savedVersion: "unrecorded" }, relatedPlans: [] }], total: 11, nextOffset: args.offset ? null : 10 },
      } }) };
    }), sendMessage: vi.fn() } as unknown as App;
    await act(async () => root.render(createElement(OrganizeKnowledge, { app, prepare, close, topicPath: topic.path })));
    const choose = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => choose().click()); await click("下一页来源"); await act(async () => choose().click());
    await click("学习"); await act(async () => choose().click());
    expect(container.textContent).toContain("已选 3 项");
    const change = async (selector: string, value: string) => act(async () => {
      const input = container.querySelector<HTMLTextAreaElement>(selector)!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await change("#knowledge-task", "归纳共同原则"); await change("#knowledge-excluded", "Wiki/excluded.md");
    await click("预览整理范围"); expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_knowledge_collect", arguments: expect.objectContaining({ projectPaths: ["Projects/project-0.md", "Projects/project-10.md"], learningPaths: ["Learning/goal.md"], excludePaths: ["Wiki/excluded.md"] }) });
    expect(prepare).not.toHaveBeenCalled(); expect(app.sendMessage).not.toHaveBeenCalled();
    await click("继续到聊天"); expect(prepare).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalled();
    expect(prepare.mock.calls[0][0].prompt).toContain("归纳共同原则"); expect(prepare.mock.calls[0][0].prompt).toContain("learning_plan_knowledge");
    expect(app.sendMessage).not.toHaveBeenCalled();
  });
});
