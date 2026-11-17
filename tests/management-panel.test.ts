// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagementPanel } from "../src/management-panel";
import type { businessApi } from "../src/business-api";
import type { KnowledgeProposal } from "../src/knowledge-types";
import type { ManagementResult, ManagedNote } from "../src/knowledge-management";

let root: Root | undefined, container: HTMLDivElement;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); });
const page = <T,>(items: T[]) => ({ items, total: items.length, nextOffset: null });
const note: ManagedNote = { path: "Projects/one.md", title: "真实项目", category: "projects", excerpt: "", version: "v1", reuse: { kind: "context", savedVersion: "unrecorded" }, relatedPlans: [], tasks: { completed: 1, total: 2 }, status: "Active", progressExcerpt: "已保存进展" };
const plan: KnowledgeProposal = { schemaVersion: 1, revision: 1, kind: "manual", status: "pending", createdAt: "2099-11-03", plan: { id: "p1", path: "Wiki/topic.md", version: "v0", before: "旧全文", after: "<script>new</script>\n新全文" } };
function fixture(owner = false) {
  const entry = { ...plan, owner: owner ? { scope: "scope", cwd: "test", sessionId: "other-chat", kind: "inbox" as const } : undefined };
  let pinned = false;
  const api = {
    management: vi.fn(async (view = "home"): Promise<ManagementResult> => view === "home" ? { view: "home", home: { pending: page([{ planId: "p1", revision: 1, path: plan.plan.path, kind: "manual", status: entry.status, createdAt: entry.createdAt, action: "修改", origin: owner ? "dsh" : "mcp" }]), sources: page([]), pinned: page(pinned ? [{ ...note, pinned }] : []), missingPins: [] } }
      : view === "projects" ? { view: "projects", page: page([{ ...note, pinned }]) }
      : view === "knowledge" ? { view: "knowledge", page: page([{ ...note, path: "Wiki/topic.md", category: "knowledge", reuse: { kind: "knowledge", savedVersion: "recorded" } }]) }
      : view === "activity" ? { view: "activity", page: page([{ id: "o1", path: plan.plan.path, kind: "update", status: "completed", at: "2099-11-03" }]) }
      : { view: "settings", settings: { service: { instanceId: "instance", vaultId: "vault", pending: 1, stopping: false }, folders: { inbox: "Inbox", knowledge: "Wiki", daily: "Daily", projects: "Projects", learning: "Learning" }, projects: [] } }),
    pendingPlans: vi.fn(async () => [entry]), inspectPlan: vi.fn(async () => ({ plan: entry.plan, revision: 1, status: entry.status })),
    previewPlan: vi.fn(async () => entry.plan), execute: vi.fn(async () => { entry.status = "completed"; return { status: "completed" }; }),
    setProjectPinned: vi.fn(async (_path: string, value: boolean) => { pinned = value; return value ? [note.path] : []; }),
    previewRestore: vi.fn(async () => ({ operationId: "o1", path: plan.plan.path, version: "v1", before: "当前全文", after: "备份全文" })),
    restore: vi.fn(async () => ({ status: "completed" })),
    provenance: vi.fn(async (path: string, version: string, offset = 0) => ({ path, version, reuse: { kind: "knowledge", savedVersion: "recorded" }, total: 2, nextOffset: offset === 0 ? 1 : null, history: [{ planId: `history-${offset}`, revision: 1, savedAt: "2099-11-03", action: "correct", beforeVersion: "v0", afterVersion: version, matchesCurrent: true, source: { path: "Inbox/source.md", version: "source-v1", state: "changed", reason: "真实来源" }, changes: [{ before: "旧说法", after: "采用说法" }] }] })),
  };
  return api;
}
async function render(api: ReturnType<typeof fixture>, writable = true) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const openReference = vi.fn();
  await act(async () => root!.render(createElement(ManagementPanel, { api: api as unknown as ReturnType<typeof businessApi>, binding: { cwd: "test", sessionId: "current-chat" }, scope: "scope", writable, openReference })));
  return openReference;
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === text);
  expect(button, text).toBeTruthy(); await act(async () => button!.click());
}
describe("shared management controls", () => {
  it("keeps home order, empty states and secondary navigation and refreshes actual service state", async () => {
    const api = fixture(); await render(api);
    const sections = [...container.querySelectorAll("section[aria-label]")].map(item => item.getAttribute("aria-label"));
    expect(sections.slice(1, 4)).toEqual(["待确认方案", "最新来源", "置顶项目进度"]);
    expect(container.textContent).toContain("未置顶项目"); expect(container.textContent).toContain("暂无已保存来源");
    await click("刷新实际状态"); expect(api.management).toHaveBeenCalledTimes(2);
    await click("设置"); expect(container.textContent).toContain("instance"); expect(container.textContent).toContain("Wiki");
  });
  it("pins across the shared API and renders task counts, saved evidence and versioned note navigation", async () => {
    const api = fixture(), open = await render(api); await click("查看全部项目");
    await click("置顶项目"); expect(api.setProjectPinned).toHaveBeenCalledWith(note.path, true);
    await click("首页"); expect(container.textContent).toContain("已完成任务 1 / 2");
    expect(container.textContent).not.toContain("50%"); expect(container.textContent).toContain("已保存进展");
    await click("打开笔记"); expect(open).toHaveBeenCalledWith({ path: note.path, version: note.version, scope: "scope" });
    await click("取消置顶"); expect(api.setProjectPinned).toHaveBeenLastCalledWith(note.path, false);
  });
  it("previews complete escaped text and requests confirmation only by a user click", async () => {
    const api = fixture(); await render(api); await click("查看方案");
    expect(api.execute).not.toHaveBeenCalled(); expect(api.previewPlan).toHaveBeenCalledWith("p1");
    expect(container.textContent).toContain("旧全文"); expect(container.textContent).toContain("新全文");
    expect(container.querySelector("script")).toBeNull();
    await click("确认保存此方案"); expect(api.execute).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("已保存");
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "确认保存此方案")).toBe(false);
  });
  it("centrally inspects another DSH conversation without offering confirmation", async () => {
    const api = fixture(true); await render(api); await click("查看方案");
    expect(container.textContent).toContain("请切回原 DSH 管家会话");
    expect(container.textContent).toContain("新全文"); expect(api.previewPlan).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "确认保存此方案")).toBe(false);
    expect(api.execute).not.toHaveBeenCalled();
  });
  it("shows full current/backup text and allows cancellation before explicitly restoring", async () => {
    const api = fixture(); await render(api); await click("记录与恢复"); await click("预览恢复");
    expect(container.textContent).toContain("当前全文"); expect(container.textContent).toContain("备份全文");
    expect(api.restore).not.toHaveBeenCalled(); await click("取消恢复"); expect(api.restore).not.toHaveBeenCalled();
    await click("预览恢复"); await click("确认恢复此版本"); expect(api.restore).toHaveBeenCalledWith("o1");
  });
  it("keeps read-only connections from pinning, confirming or restoring", async () => {
    const api = fixture(); await render(api, false); await click("查看方案");
    expect(container.textContent).toContain("当前为只读连接");
    expect(api.previewPlan).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "确认保存此方案")).toBe(false);
    await click("项目"); await click("置顶项目"); expect(api.setProjectPinned).not.toHaveBeenCalled();
    await click("记录与恢复"); await click("预览恢复"); await click("确认恢复此版本"); expect(api.restore).not.toHaveBeenCalled();
  });
  it("browses version-bound provenance with full changes, changed-source warning and explicit continuation", async () => {
    const api = fixture(), open = await render(api); await click("知识"); await click("查看来源与纠正");
    expect(container.textContent).toContain("旧说法"); expect(container.textContent).toContain("采用说法"); expect(container.textContent).toContain("原版本已变化");
    await click("打开来源"); expect(open).toHaveBeenCalledWith({ path: "Inbox/source.md", version: "source-v1", scope: "scope" });
    await click("下一条保存关系"); expect(api.provenance).toHaveBeenLastCalledWith("Wiki/topic.md", "v1", 1);
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "下一条保存关系")).toBe(false);
  });
});
