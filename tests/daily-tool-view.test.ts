// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DailyToolView } from "../src/daily-tool-view";
import { defaultFolders, vaultScope } from "../src/business-api";
import type { DailyPreview } from "../src/assistant-daily";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

function fixture() {
  const vault = { root: "D:/test", folders: defaultFolders };
  const identity = { planId: "p1", scope: vaultScope(vault), cwd: vault.root, sessionId: "s1" };
  const preview: DailyPreview = { plan: { id: "p1", path: "Daily/2026-10-10.md", before: "# 原文\n", after: "# 原文\n\n学习 TypeScript\n", version: "v1" }, status: "pending" };
  const config = { status: "ready", writable: true, mode: "host", value: { vault, binding: { sessionId: "s1", cwd: vault.root } } };
  const call = vi.fn(async (_channel, method, payload): Promise<{ ok: true; value: unknown }> => {
    expect(payload).toMatchObject(identity);
    if (method.endsWith("/assistant-daily-confirm")) return { ok: true, value: { ...preview, status: "completed" } };
    if (method.endsWith("/assistant-daily-cancel")) return { ok: true, value: { ...preview, status: "cancelled" } };
    return { ok: true, value: preview };
  });
  const props = { block: { kind: "tool-result", isError: false, content: [], meta: { dailyProposal: identity } },
    useConfiguration: () => config, rpc: { call }, openReference: vi.fn() } as unknown as ComponentProps<typeof DailyToolView>;
  const render = async () => { await act(async () => root.render(createElement(DailyToolView, props))); };
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === label)!;
    expect(button).toBeDefined(); await act(async () => button.click());
  };
  return { render, click, call, config, props };
}

it.each([
  ["learning_plan_goal_review_date", "设置下次复习日期", "goal", "Learning/goal.md"],
  ["learning_plan_goal_recall", "保存手动复习记录", "goal", "Learning/goal.md"],
  ["learning_plan_goal_steps", "追加学习行动计划", "goal", "Learning/goal.md"],
  ["learning_plan_goal_task", "更新学习任务勾选", "goal", "Learning/goal.md"],
  ["learning_plan_project_status", "更新项目状态", "project", "Projects/project.md"],
])("renders %s with the existing confirmation channel and opens its saved note", async (toolName, label, kind, path) => {
  const f = fixture();
  const identity = { planId: "p1", scope: vaultScope(f.config.value.vault), cwd: f.config.value.vault.root, sessionId: "s1" };
  f.props.toolName = toolName;
  if ("kind" in f.props.block) f.props.block.meta = { [`${kind}Proposal`]: identity };
  f.call.mockImplementation(async (_channel, method) => ({ ok: true, value: method.endsWith("/read") ? { path, version: "saved-version" }
    : { plan: { id: "p1", path, before: "Original", after: "Changed", version: "v1" }, status: method.endsWith("confirm") ? "completed" : "pending" } }));
  await f.render();
  expect(container.textContent).toContain(label);
  expect(container.textContent).toContain("Original");
  expect(container.textContent).toContain("Changed");
  expect(f.call.mock.calls.map(call => call[1])).toEqual([`learning-os/assistant-${kind}-preview`]);
  await f.click("确认保存");
  expect(f.call.mock.calls[1][1]).toBe(`learning-os/assistant-${kind}-confirm`);
  expect(container.textContent).toContain("已保存");
  await f.click("查看已保存笔记");
  expect(f.props.openReference).toHaveBeenCalledWith({ path, version: "saved-version", scope: identity.scope });
});

it("shows trusted review coverage and original source versions before confirming through report routes", async () => {
  const f = fixture();
  const identity = { planId: "p1", scope: vaultScope(f.config.value.vault), cwd: f.config.value.vault.root, sessionId: "s1" };
  f.props.toolName = "learning_plan_review";
  if ("kind" in f.props.block) f.props.block.meta = { reportProposal: identity, total: 999 };
  f.call.mockImplementation(async (_channel, method) => ({ ok: true, value: method.endsWith("/read")
    ? { path: "Projects/demo.md", version: "latest-version" }
    : { plan: { id: "p1", path: "Wiki/Review.md", before: "", after: "# Review\nSummary", version: "v1", create: true,
      report: { startDate: "2026-10-27", endDate: "2026-10-28", collectedAt: "2026-10-28T12:00:00Z", total: 5, missingDailyDates: ["2026-10-27"], excludedDailyNotes: 1,
        sources: [{ path: "Projects/demo.md", version: "original-version", timeBasis: "current-snapshot" }] } }, status: method.endsWith("confirm") ? "completed" : "pending" } }));
  await f.render();
  expect(container.textContent).toContain("保存进展汇总");
  expect(container.textContent).toContain("2026-10-27 至 2026-10-28");
  expect(container.textContent).toContain("选用 1 / 5 篇");
  expect(container.textContent).toContain("当前无日期快照");
  expect(container.textContent).not.toContain("999");
  expect(f.call.mock.calls[0][1]).toBe("learning-os/assistant-report-preview");
  await f.click("查看来源：Projects/demo.md");
  expect(f.props.openReference).toHaveBeenCalledWith({ path: "Projects/demo.md", version: "original-version", scope: identity.scope });
  await f.click("确认保存");
  expect(f.call.mock.calls[2][1]).toBe("learning-os/assistant-report-confirm");
  expect(container.textContent).toContain("已保存");
});

it("previews a new learning goal and opens it after confirmation through the existing goal routes", async () => {
  const f = fixture();
  const identity = { planId: "p1", scope: vaultScope(f.config.value.vault), cwd: f.config.value.vault.root, sessionId: "s1" };
  f.props.toolName = "learning_plan_goal";
  if ("kind" in f.props.block) f.props.block.meta = { goalProposal: identity };
  f.call.mockImplementation(async (_channel, method) => ({ ok: true, value: method.endsWith("/read")
    ? { path: "Learning/TypeScript.md", version: "saved-version" }
    : { plan: { id: "p1", path: "Learning/TypeScript.md", before: "", after: "# TypeScript\n\n## Outcome\nWrite a parser", version: "v1", create: true },
      status: method.endsWith("confirm") ? "completed" : "pending" } }));
  await f.render();
  expect(container.textContent).toContain("创建学习目标");
  expect(container.textContent).toContain("将新建笔记（没有原文）");
  expect(container.textContent).toContain("Write a parser");
  expect(f.call.mock.calls.map(call => call[1])).toEqual(["learning-os/assistant-goal-preview"]);
  await f.click("确认保存");
  expect(f.call.mock.calls[1][1]).toBe("learning-os/assistant-goal-confirm");
  expect(container.textContent).toContain("已保存");
  await f.click("查看已保存笔记");
  expect(f.props.openReference).toHaveBeenCalledWith({ path: "Learning/TypeScript.md", version: "saved-version", scope: identity.scope });
});

it("previews and cancels goal evidence through its own endpoints", async () => {
  const f = fixture();
  const identity = { planId: "p1", scope: vaultScope(f.config.value.vault), cwd: f.config.value.vault.root, sessionId: "s1" };
  f.props.toolName = "learning_plan_goal_evidence";
  if ("kind" in f.props.block) f.props.block.meta = { goalProposal: identity };
  f.call.mockImplementation(async (_channel, method) => ({ ok: true, value: { plan: { id: "p1", path: "Learning/goal.md", before: "# Goal", after: "# Goal\n\n## Evidence\nExercise completed", version: "v1" }, status: method.endsWith("cancel") ? "cancelled" : "pending" } }));
  await f.render();
  expect(container.textContent).toContain("记录学习证据");
  expect(f.call.mock.calls[0][1]).toBe("learning-os/assistant-goal-preview");
  await f.click("取消方案");
  expect(f.call.mock.calls[1][1]).toBe("learning-os/assistant-goal-cancel");
  expect(container.textContent).toContain("已取消 · 未写入");
});

it("shows correction snippets, authoritative revision and preserved content, then disables a superseded card", async () => {
  const f = fixture();
  const identity = { planId: "p1", scope: vaultScope(f.config.value.vault), cwd: f.config.value.vault.root, sessionId: "s1" };
  f.props.toolName = "learning_revise_correction";
  if ("kind" in f.props.block) f.props.block.meta = { inboxProposal: identity };
  const plan = { id: "p1", path: "Wiki/topic.md", before: "Old claim.\nKeep evidence.", after: "Scoped claim.\nKeep evidence.", version: "v1",
    inbox: { path: "Inbox/handoff.md", version: "source-v1", reason: "Only tested under narrower conditions" },
    correction: { changes: [{ before: "Old claim.", after: "Scoped claim." }] } };
  f.call.mockResolvedValue({ ok: true, value: { plan, revision: 2, status: "pending" } });
  await f.render();
  expect(container.textContent).toContain("纠正已有知识");
  expect(container.textContent).toContain("修订：2");
  expect(container.textContent).toContain("本次替换内容");
  expect(container.textContent).toContain("Old claim.");
  expect(container.textContent).toContain("Scoped claim.");
  expect(container.textContent).toContain("Keep evidence.");
  expect(container.textContent).not.toContain("追加到已有知识笔记");
  f.call.mockResolvedValue({ ok: true, value: { plan, revision: 2, status: "superseded" } });
  await act(async () => root.render(null)); await f.render();
  expect(container.textContent).toContain("已被新版替代");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent === "确认保存")).toBe(false);
  expect(f.call.mock.calls.some(call => call[1].endsWith("confirm"))).toBe(false);
});

it("shows the trusted Inbox recommendation and source, opens the original version and confirms the correct route", async () => {
  const f = fixture();
  const identity = { planId: "p1", scope: vaultScope(f.config.value.vault), cwd: f.config.value.vault.root, sessionId: "s1" };
  f.props.toolName = "learning_plan_inbox";
  if ("kind" in f.props.block) f.props.block.meta = { inboxProposal: identity, reason: "untrusted model label" };
  f.call.mockImplementation(async (_channel, method) => ({ ok: true, value: method.endsWith("/read")
    ? { path: "Inbox/source.md", version: "new-source-version" }
    : { plan: { id: "p1", path: "Wiki/target.md", before: "# Existing", after: "# Existing\nAdded", version: "v1", create: false,
      inbox: { path: "Inbox/source.md", version: "original-source-version", reason: "Same topic in existing note" } }, status: method.endsWith("confirm") ? "completed" : "pending" } }));
  await f.render();
  expect(container.textContent).toContain("整理一条 Inbox");
  expect(container.textContent).toContain("追加到已有知识笔记");
  expect(container.textContent).toContain("原始 Inbox 保留");
  expect(container.textContent).toContain("Same topic in existing note");
  expect(container.textContent).not.toContain("untrusted model label");
  expect(f.call.mock.calls[0][1]).toBe("learning-os/assistant-inbox-preview");
  await f.click("查看 Inbox 原文");
  expect(f.props.openReference).toHaveBeenCalledWith({ path: "Inbox/source.md", version: "original-source-version", scope: identity.scope });
  await f.click("确认保存");
  expect(f.call.mock.calls[2][1]).toBe("learning-os/assistant-inbox-confirm");
  expect(container.textContent).toContain("已保存");
});

it("reads the authoritative preview, waits for a click and restores the saved state on remount", async () => {
  const f = fixture(); await f.render();
  expect(container.textContent).toContain("待确认 · 尚未写入");
  expect(container.textContent).toContain("学习 TypeScript");
  expect(f.call.mock.calls.map(call => call[1])).toEqual(["learning-os/assistant-daily-preview"]);
  await f.click("确认保存");
  expect(container.textContent).toContain("已保存");
  expect(container.textContent).not.toContain("确认保存");
  f.call.mockResolvedValue({ ok: true, value: { plan: { id: "p1", path: "Daily/test.md", before: "", after: "", version: "v" }, status: "completed" } });
  await act(async () => root.render(null)); await f.render();
  expect(container.textContent).toContain("已保存");
  expect(f.call.mock.calls.filter(call => call[1].endsWith("confirm"))).toHaveLength(1);
});

it("cancels without calling confirm and disables an old card after a binding switch", async () => {
  const f = fixture(); await f.render(); await f.click("取消方案");
  expect(container.textContent).toContain("已取消 · 未写入");
  expect(f.call.mock.calls.some(call => call[1].endsWith("confirm"))).toBe(false);
  f.config.value.binding.sessionId = "s2"; await f.render();
  expect(container.textContent).toContain("管家会话已变化");
  expect(container.querySelector("button")).toBeNull();
});

it("rejects expired previews and reports write failures without showing saved", async () => {
  const f = fixture();
  f.call.mockRejectedValueOnce(new Error("方案已失效")); await f.render();
  expect(container.textContent).toContain("方案已失效");
  expect(container.querySelector("button")).toBeNull();
  await act(async () => root.render(null)); await f.render();
  f.call.mockResolvedValueOnce({ ok: true, value: { plan: { id: "p1", path: "Daily/test.md", before: "", after: "", version: "v" }, status: "failed", result: { id: "p1", path: "Daily/test.md", kind: "update", status: "failed", at: "2026-10-10", error: "Note changed externally" } } });
  await f.click("确认保存");
  expect(container.textContent).toContain("Note changed externally");
  expect(container.textContent).not.toContain("已保存");
});

it("uses the project preview and confirmation endpoints, and opens the saved project reference", async () => {
  const f = fixture();
  const identity = { planId: "p1", scope: vaultScope(f.config.value.vault), cwd: f.config.value.vault.root, sessionId: "s1" };
  f.props.toolName = "learning_plan_project_progress";
  if ("kind" in f.props.block) f.props.block.meta = { projectProposal: identity };
  f.call.mockImplementation(async (_channel, method) => ({ ok: true, value: { plan: { id: "p1", path: "Projects/test.md", before: "# Project", after: "# Project\n\n## Progress\n\nFinished a test\n", version: "v1" },
    status: method.endsWith("confirm") ? "completed" : "pending" } }));
  await f.render();
  expect(container.textContent).toContain("更新项目进展");
  expect(container.textContent).toContain("Projects/test.md");
  expect(f.call.mock.calls[0][1]).toBe("learning-os/assistant-project-preview");
  await f.click("确认保存");
  expect(f.call.mock.calls[1][1]).toBe("learning-os/assistant-project-confirm");
  f.call.mockResolvedValueOnce({ ok: true, value: { plan: { id: "p1", path: "Projects/test.md", before: "", after: "", version: "v1" }, status: "completed", path: "Projects/test.md", version: "saved-version" } });
  await f.click("查看已保存笔记");
  expect(f.props.openReference).toHaveBeenCalledWith({ path: "Projects/test.md", version: "saved-version", scope: identity.scope });
});
