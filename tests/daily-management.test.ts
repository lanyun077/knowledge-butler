// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DailyManagement, type DailyManagementApi } from "../src/daily-management";
import type { DueReviews } from "../src/due-reviews";
import type { RoutineStatus } from "../src/routines";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function fixture(available = true) {
  const goal = { path: "Learning/goal.md", title: "Goal", category: "learning", content: "# Goal", excerpt: "", version: "v1" };
  const due: DueReviews = { date: "2026-10-28", total: 1, unscheduled: 2, invalid: [], nextOffset: 1, truncated: false,
    sources: [{ path: goal.path, title: goal.title, version: goal.version, date: "2026-10-27", overdue: true }] };
  const status: RoutineStatus = { available, items: [], ...(!available ? { reason: "需要启用官方 Schedule" } : {}) };
  const api = {
    list: vi.fn(async () => [goal]), read: vi.fn(async () => goal), dueReviews: vi.fn(async () => due),
    planGoalReviewDate: vi.fn(async () => ({ id: "p1", path: goal.path, version: goal.version, before: goal.content, after: "Changed" })),
    execute: vi.fn(async () => ({ id: "p1", path: goal.path, kind: "update" as const, status: "completed" as const, at: "2026-10-28T00:00:00Z" })),
    routines: vi.fn(async () => status),
    setRoutine: vi.fn(async (_binding, kind, enabled, timeZone) => ({ available: true, items: enabled ? [{ id: "r1", kind, currentScope: true, timeZone, date: "2026-10-28", scheduledAt: "2026-10-29T00:00:00Z", state: "scheduled" }] : [] })),
    stopRoutine: vi.fn(async () => status),
  } satisfies DailyManagementApi;
  const binding = { cwd: "D:/test", sessionId: "s1" };
  const openReference = vi.fn();
  await act(async () => root.render(createElement(DailyManagement, { api, binding, scope: "scope1", openReference })));
  return { api, binding, openReference };
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent === label)!;
  expect(button).toBeDefined(); await act(async () => button.click());
}
async function input(selector: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

it("opens due references, previews review dates before saving, and individually enables and pauses the reminder", async () => {
  const f = await fixture();
  expect(container.textContent).toContain("已逾期");
  expect(container.textContent).toContain("另有 2 个未设置日期");
  expect(f.api.setRoutine).not.toHaveBeenCalled();
  await click("Goal");
  expect(f.openReference).toHaveBeenCalledWith({ path: "Learning/goal.md", version: "v1", scope: "scope1" });
  await input("select", "Learning/goal.md");
  await input('[aria-label="设置复习日期"] input[type="date"]', "2026-11-02");
  await click("预览复习日期");
  expect(f.api.planGoalReviewDate).toHaveBeenCalledWith("Learning/goal.md", "v1", "2026-11-02");
  expect(f.api.execute).not.toHaveBeenCalled();
  await click("取消复习日期方案");
  expect(f.api.execute).not.toHaveBeenCalled();
  await click("预览复习日期"); await click("确认保存复习日期");
  expect(f.api.execute).toHaveBeenCalledTimes(1);
  expect(f.api.execute).toHaveBeenCalledWith("p1");
  await click("开启每24小时复习提醒");
  expect(f.api.setRoutine).toHaveBeenLastCalledWith(f.binding, "review-reminder", true, expect.any(String));
  expect(container.textContent).toContain("下次：");
  await click("暂停每24小时复习提醒");
  expect(f.api.setRoutine).toHaveBeenLastCalledWith(f.binding, "review-reminder", false, expect.any(String));
  expect(container.textContent).toContain("每7天周报 · 已暂停");
});

it("shows unavailable native scheduling without presenting successful enable controls", async () => {
  const f = await fixture(false);
  expect(container.textContent).toContain("需要启用官方 Schedule");
  expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent?.startsWith("开启每"))).toBe(false);
  expect(f.api.setRoutine).not.toHaveBeenCalled();
});
