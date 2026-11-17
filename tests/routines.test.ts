import { Context } from "@deepseek-ai/cordis";
import { emitAgentEvent, type Agent } from "@deepseek-ai/dsh-agent";
import SessionStore, { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as Schedule from "@deepseek-ai/dsh-schedule";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import { afterEach, expect, it, vi } from "vitest";
import { assistantRoutines } from "../src/routines";
import { defaultFolders, vaultScope, type PlainConfig } from "../src/business-api";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

async function fixture(seed: readonly SessionEvent[] = []) {
  const ctx = new Context();
  const sessions = ctx.plugin(SessionStore); await sessions.await();
  const prompt = ctx.plugin(SystemPrompt, {}); await prompt.await();
  const tools = ctx.plugin(ToolRuntime); await tools.await();
  const session = ctx.sessions.create(SessionId("routine-session"), { meta: { cwd: "D:/test" }, seed });
  const followed: unknown[] = [];
  const agent = { id: session.id, session, status: "idle", options: {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: (work: (signal: AbortSignal) => unknown) => work(new AbortController().signal),
    followup: (message: unknown) => followed.push(message),
  } as unknown as Agent;
  let scope!: Scope;
  const minter = ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent); Object.assign(agent, { ctx: scope.ctx });
  }, { inject: ["tools", "systemPrompt"] }));
  await minter.await();
  ctx.provide("agents", { get: (id: string) => id === agent.id ? agent : undefined, roots: () => [agent], withoutInitiator: (work: () => unknown) => work() } as never);
  ctx.provide("sessionPersistence", {} as never);
  // The official barrier is acknowledged locally; this test does not simulate a real process or disk backend.
  let persisted: readonly SessionEvent[] = [];
  let failFlush = false;
  ctx.on("session/flush", async () => {
    if (failFlush) throw new Error("persistence unavailable");
    persisted = session.ownEvents();
  });
  const native = ctx.plugin(Schedule); await native.await();
  emitAgentEvent(ctx, agent, "agent/created", { source: "startup" });
  const config: PlainConfig = { vault: { root: "D:/test", folders: defaultFolders }, binding: { cwd: "D:/test", sessionId: agent.id } };
  const routines = assistantRoutines(ctx, () => config);
  cleanups.push(async () => { await native.dispose(); await scope.dispose(); await minter.dispose(); await tools.dispose(); await prompt.dispose(); await sessions.dispose(); });
  return { routines, scope: vaultScope(config.vault), signal: new AbortController().signal, followed, persisted: () => persisted, failFlush: () => { failFlush = true; } };
}

it("uses official Schedule timers for daily reminders and weekly followups, and stops dispatch after pausing", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T16:30:00Z"));
  const f = await fixture();
  await f.routines.set(f.scope, "review-reminder", true, "Asia/Shanghai", f.signal);
  const state = await f.routines.set(f.scope, "weekly-report", true, "Asia/Shanghai", f.signal);
  expect(state.items.find(item => item.kind === "weekly-report")).toMatchObject({ date: "2026-10-29", startDate: "2026-10-22", endDate: "2026-10-28" });
  await vi.advanceTimersByTimeAsync(86400000);
  expect(f.followed).toHaveLength(1);
  expect(JSON.stringify(f.followed[0])).toContain("review-reminder");
  await f.routines.set(f.scope, "review-reminder", false, "", f.signal);
  await vi.advanceTimersByTimeAsync(6 * 86400000);
  expect(f.followed).toHaveLength(2);
  expect(JSON.stringify(f.followed[1])).toContain("weekly-report");
  await f.routines.set(f.scope, "weekly-report", false, "", f.signal);
  await vi.advanceTimersByTimeAsync(7 * 86400000);
  expect(f.followed).toHaveLength(2);
});

it("replays active native schedules and reports persistence failure without pretending success", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
  const first = await fixture();
  const enabled = await first.routines.set(first.scope, "weekly-report", true, "UTC", first.signal);
  const restored = await fixture(first.persisted());
  expect((await restored.routines.list(restored.scope, restored.signal)).items[0].id).toBe(enabled.items[0].id);
  restored.failFlush();
  await expect(restored.routines.set(restored.scope, "weekly-report", false, "", restored.signal)).rejects.toThrow("persistence_uncertain");
});
