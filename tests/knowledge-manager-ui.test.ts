// @vitest-environment jsdom
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Manager } from "../src/manager/view";
vi.mock("../src/manager/star-map", () => ({ StarMap: () => null }));
import { managerInput, managerSnapshot, type ManagerInput } from "../src/knowledge-manager-contract";

let root: Root | undefined, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); delete document.documentElement.dataset.theme; });
const version = "a".repeat(64), reuse = { kind: "knowledge" as const, savedVersion: "unrecorded" as const };
const note = { title: "真实资料", path: "Wiki/topic.md", category: "knowledge", excerpt: "服务端摘要", version, reuse, relatedPlans: [] };
const record = { recordId: "record-1", path: note.path, title: note.title, summary: note.excerpt, status: "completed", savedAt: "2026-11-04T00:00:00Z", origin: "https://example.com/source" };
const page = <T,>(items: T[], total = items.length, nextOffset: number | null = null) => ({ items, total, nextOffset });
function snapshot(input: ManagerInput = {}) {
  const request = managerInput.parse(input);
  const management = request.view === "home" ? { view: "home", home: { pending: page([]), sources: page([note]), pinned: page([]), missingPins: [], records: page([record]), knowledge: page([]), learning: page([]) } }
    : { view: request.view, page: page<typeof note | typeof record>(request.view === "records" ? [record] : [note], 12, request.offset === 0 ? 10 : null) };
  const detail = { path: note.path, title: note.title, category: note.category, version, reuse,
    content: "---\nsourceName: Hidden YAML metadata\n---\n# 正文\n<script>window.evil=1</script>\n\n[危险链接](javascript:alert(1))\n![外部图片](https://example.com/a.png)\n\n完整段落", offset: request.offset, total: 9000, nextOffset: request.offset === 0 ? 8000 : null,
    provenance: { path: note.path, version, reuse, total: 2, nextOffset: request.historyOffset === 0 ? 1 : null,
      history: [{ planId: "saved-1", revision: 1, savedAt: "2026-11-04T00:00:00Z", action: "append", beforeVersion: version, afterVersion: version, matchesCurrent: true,
        source: { path: "Inbox/source.md", version, state: "changed", reason: "保留真实来源" } }] }, relatedPlans: [] };
  return managerSnapshot.parse({ stage: "U2", resourceVersion: "u2-v4", libraryId: "test-library", readAt: "2026-11-04T00:00:00Z", request,
    ...(["summary", "detail"].includes(request.view) ? { detail: request.view === "summary" ? { ...detail, content: "", summary: "仅有界概况", nextOffset: null, openUri: "obsidian://open?path=topic" } : detail } : { management }) });
}
function bridge() {
  const instance = {
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    getHostContext: vi.fn(() => ({ theme: "light" })), getHostCapabilities: vi.fn(() => ({ serverTools: {} })),
    sendMessage: vi.fn(async () => ({})),
    callServerTool: vi.fn(async ({ arguments: args }: { name: string; arguments: ManagerInput }, _options?: { timeout: number }): Promise<CallToolResult> => ({ content: [], structuredContent: { ...snapshot(args), canConfirm: true } })),
  };
  return instance as typeof instance & App;
}
async function render(app: ReturnType<typeof bridge>, initial = true) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(Manager, { app })));
  if (initial) await act(async () => app.ontoolresult!({ content: [], structuredContent: snapshot() }));
}
function button(text: string) {
  const element = Array.from(container.querySelectorAll("button")).find(item => item.getAttribute("aria-label") === text || item.textContent === text);
  expect(element, text).toBeTruthy(); return element!;
}
async function click(text: string) {
  if (["概览", "记录", "知识", "项目", "学习", "设置"].includes(text) && !container.querySelector("nav")) await act(async () => button("打开导航").click());
  await act(async () => button(text).click());
}

describe("Codex manager", () => {
  it("previews a user request and sends it once only after the user's explicit click", async () => {
    const app = bridge(); app.getHostCapabilities.mockReturnValue({ serverTools: {}, message: { text: {} } } as never);
    await render(app); await click("开始操作"); await click("保存资料");
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    const prompt = container.querySelector<HTMLTextAreaElement>("#manager-request")!.value;
    expect(prompt).toContain("准确预览"); expect(app.sendMessage).not.toHaveBeenCalled();
    const reads = app.callServerTool.mock.calls.length;
    let finish!: (value: {}) => void;
    app.sendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await click("发送到当前聊天"); await click("正在发送…");
    expect(app.sendMessage).toHaveBeenCalledTimes(1);
    expect(app.sendMessage).toHaveBeenCalledWith({ role: "user", content: [{ type: "text", text: prompt }] });
    expect(app.callServerTool.mock.calls.length).toBe(reads);
    await act(async () => finish({}));
    expect(container.textContent).toContain("请求已发送"); expect(button("请在聊天中继续").disabled).toBe(true);
    await click("关闭操作"); expect(document.activeElement).toBe(button("开始操作"));
    await click("查看保存结果");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: { view: "records" } });
  });

  it("opens bounded summaries by default and keeps full bodies out of the page", async () => {
    const app = bridge(); await render(app); await click("查看详情：真实资料");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: { view: "summary", path: note.path } });
    expect(container.textContent).toContain("仅有界概况"); expect(container.querySelector(".markdown")).toBeNull();
    expect(container.textContent).not.toContain("完整段落"); expect(button("在 Obsidian 打开")).toBeTruthy();
  });

  it("offers a selectable copy fallback without messaging when the host lacks text-message support", async () => {
    const app = bridge(); await render(app); await click("开始操作"); await click("记录今天");
    expect(Array.from(container.querySelectorAll("button")).some(item => item.textContent?.includes("发送到当前聊天"))).toBe(false);
    await click("复制请求");
    const prompt = container.querySelector<HTMLTextAreaElement>("#manager-request")!;
    expect(prompt.selectionEnd - prompt.selectionStart).toBe(prompt.value.length);
    expect(container.textContent).toContain("请复制已选中的请求"); expect(app.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps a rejected or uncertain message visible for manual continuation without automatic retries", async () => {
    const app = bridge(); app.getHostCapabilities.mockReturnValue({ serverTools: {}, message: { text: {} } } as never);
    await render(app); await click("知识"); await click("查找知识");
    app.sendMessage.mockResolvedValueOnce({ isError: true } as never); await click("发送到当前聊天");
    expect(container.textContent).toContain("聊天未接收");
    app.sendMessage.mockRejectedValueOnce(new Error("Disconnected")); await click("发送到当前聊天");
    expect(container.textContent).toContain("暂时无法确认是否送达"); expect(app.sendMessage).toHaveBeenCalledTimes(2);
    expect(button("请在聊天中继续").disabled).toBe(true);
  });

  it("targets the exact current project and returns through nested details to the original list position", async () => {
    const app = bridge(); await render(app); await click("项目");
    const scroll = container.querySelector<HTMLDivElement>(".workspace-scroll")!; scroll.scrollTop = 360;
    const detail = snapshot({ view: "detail", path: note.path }); detail.detail!.category = "projects";
    app.callServerTool.mockResolvedValueOnce(toolResult(detail)); await click("查看详情：真实资料");
    await click("开始操作"); await click("更新项目");
    expect(container.querySelector<HTMLTextAreaElement>("#manager-request")!.value).toContain(JSON.stringify(note.path));
    expect(app.sendMessage).not.toHaveBeenCalled(); await click("关闭操作");
    const source = snapshot({ view: "detail", path: "Inbox/source.md" }); source.detail!.path = "Inbox/source.md";
    app.callServerTool.mockResolvedValueOnce(toolResult(source)); await click("查看来源");
    await click("关闭详情");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: detail.request });
    await click("关闭详情");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: expect.objectContaining({ view: "projects" }) });
    expect(scroll.scrollTop).toBe(360); expect(document.activeElement).toBe(button("查看详情：真实资料"));
  });

  it("clears an empty filtered list without changing its category", async () => {
    const app = bridge(); await render(app);
    const filtered = snapshot({ view: "projects", query: "no-match" }); filtered.management!.page = page([]);
    await act(async () => app.ontoolresult!(toolResult(filtered)));
    expect(container.textContent).toContain("没有找到匹配的内容"); await click("清空筛选");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: { view: "projects" } });
  });

  it("uses a six-entry popup navigation and closes it with Escape", async () => {
    const app = bridge(); await render(app);
    expect(container.querySelector("nav")).toBeNull();
    await click("打开导航");
    expect(Array.from(container.querySelectorAll("nav button")).map(item => item.textContent)).toEqual(["概览", "记录", "知识", "项目", "学习", "设置"]);
    expect(document.activeElement).toBe(button("概览"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("nav")).toBeNull(); expect(document.activeElement).toBe(button("打开导航"));
  });

  it("manages modules with drag-handle keyboard sorting, persists layout and theme, and isolates libraries", async () => {
    const app = bridge(); await render(app); await click("管理模块");
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    await click("添加学习目标"); await click("添加最近知识"); await click("移除待保存");
    expect(container.textContent).not.toContain("上移"); expect(container.textContent).not.toContain("下移");
    button("拖动排序学习目标").focus();
    await act(async () => button("拖动排序学习目标").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    await click("完成");
    const order = () => Array.from(container.querySelectorAll(".module-grid > section")).map(item => item.getAttribute("data-module"));
    expect(order()).toEqual(["projects", "learning", "records", "knowledge"]);
    await click("切换为深色");
    await act(async () => app.onhostcontextchanged!({ theme: "light" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await act(async () => root!.unmount()); root = undefined; container.remove();
    const reopened = bridge(); await render(reopened);
    expect(order()).toEqual(["projects", "learning", "records", "knowledge"]);
    expect(document.documentElement.dataset.theme).toBe("dark");
    await act(async () => reopened.ontoolresult!(toolResult({ ...snapshot(), libraryId: "another-library" })));
    expect(order()).toEqual(["pending", "projects", "records"]);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("shows actual record fields without turning source URLs into executable links", async () => {
    const app = bridge(); await render(app); await click("记录");
    expect(container.textContent).toContain("保存时间"); expect(container.textContent).toContain(note.path);
    expect(container.textContent).toContain("https://example.com/source"); expect(container.textContent).toContain(record.summary);
    expect(container.querySelector("a[href]")).toBeNull();
  });

  it("keeps home order and list pagination, restores list focus and refreshes shared data", async () => {
    const app = bridge(); await render(app);
    expect(Array.from(container.querySelectorAll("section[aria-label]")).map(item => item.getAttribute("aria-label"))).toEqual(["待保存", "置顶项目", "最近记录"]);
    expect(container.textContent).toContain("暂无内容");
    await click("记录"); await click("下一页列表");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: expect.objectContaining({ view: "records", offset: 10 }) });
    button("查看详情：真实资料").focus(); await click("查看详情：真实资料");
    expect(document.activeElement?.textContent).toBe("真实资料");
    await click("关闭详情");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: expect.objectContaining({ view: "records", offset: 10 }) });
    expect(document.activeElement).toBe(button("查看详情：真实资料"));
    await click("概览");
    app.callServerTool.mockResolvedValueOnce({ content: [], structuredContent: { ...snapshot(), management: { view: "home", home: { pending: page([]), sources: page([]), pinned: page([]), missingPins: [], records: page([]), knowledge: page([]), learning: page([]) } } } });
    await click("刷新"); expect(container.textContent).not.toContain("服务端摘要");
    expect(Array.from(container.querySelectorAll("button")).some(item => /确认保存|取消方案|置顶项目|恢复/.test(item.textContent ?? ""))).toBe(false);
  });

  it("pages bodies and provenance with the pinned version, renders inert Markdown and recovers from a changed note", async () => {
    const app = bridge(); await render(app); await act(async () => app.ontoolresult!(toolResult(snapshot({ view: "detail", path: note.path }))));
    expect(container.textContent).toContain("完整段落"); expect(container.textContent).toContain("来源已修改");
    expect(container.querySelector("script, img, a[href], iframe")).toBeNull();
    expect(container.querySelector(".markdown")?.textContent).not.toContain("Hidden YAML metadata");
    await click("下一页正文");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: expect.objectContaining({ offset: 8000, version }) });
    await click("下一页来源记录");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: expect.objectContaining({ offset: 8000, historyOffset: 1, version }) });
    app.callServerTool.mockRejectedValueOnce(new Error("Note changed"));
    await click("上一页正文"); expect(container.querySelector('[role="alert"]')?.textContent).toContain("Note changed");
    expect(container.textContent).toContain("完整段落");
    await click("刷新"); expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: { view: "detail", path: note.path } });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows loading, prevents duplicate calls and applies live host themes and closed state", async () => {
    const app = bridge(); await render(app);
    let finish!: (value: { content: never[]; structuredContent: ReturnType<typeof snapshot> }) => void;
    app.callServerTool.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await click("记录");
    expect(container.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    expect(button("正在读取…").disabled).toBe(true); expect(button("打开导航").disabled).toBe(true);
    await act(async () => { finish({ content: [], structuredContent: snapshot({ view: "records" }) }); });
    expect(container.querySelector("main")?.getAttribute("aria-busy")).toBe("false");
    await act(async () => app.onhostcontextchanged!({ theme: "dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await act(async () => app.onclose!()); expect(button("刷新").disabled).toBe(true);
    expect(container.textContent).toContain("重新展示管家主页");
  });

  it("keeps text fallback guidance when the host cannot call UI tools", async () => {
    const app = bridge(); app.getHostCapabilities.mockReturnValue({} as never);
    await render(app, false); expect(container.textContent).toContain("文字工具"); expect(button("刷新").disabled).toBe(true);
  });
});

const planId = "00000000-0000-4000-8000-000000000001";
const proposal = { plan: { id: planId, path: note.path, before: "旧正文", after: "新正文\n<script>unsafe()</script>", version }, revision: 1, kind: "inbox", status: "pending" };
const toolResult = (value: object): CallToolResult => ({ content: [], structuredContent: { ...value } });
async function showPlan(app: ReturnType<typeof bridge>, canConfirm = true, owner = false) {
  await render(app);
  const initial = snapshot(); initial.canConfirm = canConfirm;
  initial.management!.home!.pending = page([{ planId, revision: 1, path: note.path, kind: "inbox", status: "pending", action: "追加", createdAt: "2026-11-05T00:00:00Z", origin: owner ? "dsh" : "mcp" }]);
  await act(async () => app.ontoolresult!(toolResult(initial)));
  app.callServerTool.mockResolvedValueOnce(toolResult({ ...proposal, ...(owner ? { owner: { scope: "test", sessionId: "original-chat", cwd: "test", kind: "inbox" } } : {}) }));
  await click("查看完整方案");
}

describe("U2 trusted controls", () => {
  it("shows source warnings and bounded evidence only when expanded, without version hashes", async () => {
    const app = bridge(); await render(app);
    const detail = snapshot({ view: "detail", path: note.path });
    detail.detail!.provenance.history[0].sources = ["changed", "missing"].map((state, i) => ({ path: `Inbox/source-${i}.md`, version, state: state as "changed" | "missing", total: 9000, ranges: [{ start: 0, end: 9000 }], evidence: [{ item: "concept", start: 0, end: 9000, preview: "原文".repeat(100), truncated: true }] }));
    await act(async () => app.ontoolresult!(toolResult(detail)));
    expect(container.textContent).toContain("整理来源 · 2 项");
    expect(container.textContent).not.toContain(version);
    const disclosure = Array.from(container.querySelectorAll("details")).find(element => element.querySelector("summary")?.textContent === "整理来源 · 2 项")!;
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
    expect(container.textContent).toContain("来源已修改"); expect(container.textContent).toContain("来源已缺失");
    expect(container.textContent).not.toContain("原文".repeat(101));
    const controls = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-note-path]'));
    expect(controls.find(button => button.dataset.notePath === "Inbox/source-1.md")?.disabled).toBe(true);
    const sourceDisclosure = Array.from(container.querySelectorAll("details")).find(element => element.querySelector("summary")?.textContent === "整理来源 · 2 项");
    expect(sourceDisclosure?.open).toBe(true);
    await click("收起");
    expect(sourceDisclosure?.open).toBe(false);
    expect(container.querySelector('button[data-note-path="Inbox/source-1.md"]')).toBeNull();
  });
  it("returns focus to the original preview control when closing without an action", async () => {
    const app = bridge(); await showPlan(app);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]')!.click());
    expect(document.activeElement).toBe(button("查看完整方案"));
  });
  it.each(["declined", "cancelled", "unchecked"])("keeps a %s confirmation separate from explicit proposal cancellation", async confirmation => {
    const app = bridge(); await showPlan(app);
    expect(container.querySelectorAll("pre")[0].textContent).toBe(proposal.plan.before);
    expect(container.querySelectorAll("pre")[1].textContent).toBe(proposal.plan.after);
    expect(container.querySelector("script")).toBeNull();
    app.callServerTool.mockResolvedValueOnce(toolResult({ ...proposal, confirmation }));
    await click("保存");
    expect(container.textContent).toContain("当前方案：待保存");
    expect(button("保存").disabled).toBe(false);
    expect(app.callServerTool).toHaveBeenCalledWith({ name: "learning_request_confirmation", arguments: { planId, revision: 1, authorization: "user-confirmed" } }, { timeout: 300000 });
    app.callServerTool.mockResolvedValueOnce(toolResult({ ...proposal, status: "cancelled" }));
    await click("取消此方案");
    expect(container.textContent).toContain("方案状态：已取消");
    expect(button("保存").disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]')!.click());
    expect(document.activeElement?.textContent).toBe("概览");
  });

  it("locks confirmation while waiting, then refreshes actual state and disables completed controls", async () => {
    const app = bridge(); await showPlan(app);
    let finish!: (value: CallToolResult) => void;
    app.callServerTool.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const calls = app.callServerTool.mock.calls.length;
    await click("保存"); await click("保存");
    expect(app.callServerTool.mock.calls.length).toBe(calls + 1);
    expect(button("取消此方案").disabled).toBe(true);
    await act(async () => finish(toolResult({ ...proposal, status: "completed", confirmation: "accepted" })));
    expect(container.textContent).toContain("当前方案：已完成");
    expect(button("保存").disabled).toBe(true);
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: snapshot().request }, { timeout: 300000 });
    await click("查看保存记录");
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: "learning_manager_probe", arguments: { view: "records", query: note.path } });
  });

  it("requires a fresh preview after a failed request and ignores unrelated tool notifications", async () => {
    const app = bridge(); await showPlan(app);
    app.callServerTool.mockRejectedValueOnce(new Error("Target changed externally"));
    await click("保存");
    expect(button("保存").disabled).toBe(true);
    expect(container.textContent).toContain("不会自动重试保存");
    app.callServerTool.mockResolvedValueOnce(toolResult({ ...proposal, status: "stale", validationError: "Target changed externally" }));
    await click("刷新");
    expect(button("保存").disabled).toBe(true);
    await act(async () => app.ontoolresult!(toolResult({ status: "completed" })));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([false, true])("saves without form support, including DSH-origin plans (DSH=%s)", async owner => {
    const app = bridge(); await showPlan(app, false, owner);
    expect(button("保存").disabled).toBe(false);
    expect(button("取消此方案").disabled).toBe(false);
    app.callServerTool.mockResolvedValueOnce(toolResult({ ...proposal, status: "completed", confirmation: "user-confirmed" }));
    await click("保存");
    expect(app.callServerTool).toHaveBeenCalledWith({ name: "learning_request_confirmation", arguments: { planId, revision: 1, authorization: "user-confirmed" } }, { timeout: 300000 });
    expect(container.textContent).toContain("当前方案：已完成");
  });

  it("consumes a restore preview once and requires another preview after cancellation", async () => {
    const app = bridge(); await render(app);
    const initial = snapshot({ view: "activity" }); initial.canConfirm = true;
    initial.management!.page = page([{ id: planId, path: note.path, kind: "update", status: "completed", at: "2026-11-05T00:00:00Z" }]);
    await act(async () => app.ontoolresult!(toolResult(initial)));
    const preview = { operationId: planId, path: note.path, version, before: "当前正文", after: "恢复正文" };
    app.callServerTool.mockResolvedValueOnce(toolResult(preview)); await click("预览恢复");
    expect(container.querySelectorAll("pre")[1].textContent).toBe("恢复正文");
    app.callServerTool.mockResolvedValueOnce(toolResult({ status: "cancelled", confirmation: "cancelled" })); await click("确认恢复");
    expect(button("确认恢复").disabled).toBe(true);
    app.callServerTool.mockResolvedValueOnce(toolResult(preview)); await click("刷新");
    expect(button("确认恢复").disabled).toBe(false);
  });

  it("pins a project only via the existing trusted tool and refreshes the shared view", async () => {
    const app = bridge(); await render(app);
    const initial = snapshot({ view: "projects" }); initial.canConfirm = true;
    initial.management!.page = page([{ ...note, category: "projects", pinned: false }]);
    await act(async () => app.ontoolresult!(toolResult(initial)));
    app.callServerTool.mockResolvedValueOnce(toolResult({ status: "completed", confirmation: "accepted", paths: [note.path] }));
    await click("置顶项目");
    expect(app.callServerTool).toHaveBeenCalledWith({ name: "learning_pin_project", arguments: { path: note.path, pinned: true } }, { timeout: 300000 });
    expect(container.textContent).toContain("项目已置顶");
  });
});
