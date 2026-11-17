import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolExecution, ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import type { ScheduleView } from "@deepseek-ai/dsh-schedule";
import { vaultScope, type PlainConfig } from "./business-api";

export type RoutineKind = "review-reminder" | "weekly-report";
export interface RoutineItem {
  id: string; kind: RoutineKind; scheduledAt: string; state: string; currentScope: boolean;
  timeZone: string; date: string; startDate?: string; endDate?: string;
}
export interface RoutineStatus { available: boolean; reason?: string; items: RoutineItem[] }
const prefix = "learning-os:routine:v1\n";
const intervals = { "review-reminder": 86400, "weekly-report": 604800 };
const nativeNames = ["schedule_list", "schedule_create", "schedule_delete"];

/** Native Schedule owns all persistence, timers and delivery. This module only manages our two opt-in rules. */
export function assistantRoutines(ctx: Context, current: () => PlainConfig) {
  const permits = new Map<string, { agent: Agent; name: string; scope: string }>();
  let tail: Promise<unknown> = Promise.resolve();
  function owner(scope: string) {
    const value = current();
    if (vaultScope(value.vault) !== scope) throw new Error("资料目录设置已变化。");
    const agent = ctx.agents.get(value.binding.sessionId as Agent["id"]);
    if (!agent || agent.session.header.cwd !== value.binding.cwd) throw new Error("请先连接管家会话。");
    return agent;
  }
  function payload(scope: string, kind: RoutineKind, timeZone: string) {
    const { sessionId, cwd } = current().binding;
    return prefix + JSON.stringify({ kind, scope, timeZone, sessionId, cwd });
  }
  function decode(record: ScheduleView): { kind: RoutineKind; scope: string; sessionId: string; cwd: string; timeZone: string } | undefined {
    if (record.kind !== "every" || !record.prompt.startsWith(prefix)) return undefined;
    let data;
    try { data = JSON.parse(record.prompt.slice(prefix.length)); } catch { return undefined; }
    if (!data || !["review-reminder", "weekly-report"].includes(data.kind)
      || ["scope", "sessionId", "cwd", "timeZone"].some(key => typeof data[key] !== "string")
      || record.everySeconds !== intervals[data.kind as RoutineKind]) return undefined;
    return data;
  }
  async function native(scope: string, name: string, args: object, signal: AbortSignal) {
    signal.throwIfAborted();
    const agent = owner(scope);
    const callId = randomUUID() as ToolExecutionInput["callId"];
    permits.set(callId, { agent, name, scope });
    try {
      const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal });
      if (result.isError) throw new Error(result.error.message);
      const value = result.value;
      if (value && typeof value === "object" && !Array.isArray(value) && "code" in value) {
        throw new Error(`宿主 Schedule：${value.code}。${value.message ?? "请刷新任务状态后重试。"}`);
      }
      if (owner(scope) !== agent) throw new Error("管家会话已变化，请刷新任务状态。");
      return value;
    } finally { permits.delete(callId); }
  }
  async function list(scope: string, signal: AbortSignal): Promise<RoutineStatus> {
    const agent = owner(scope);
    if (nativeNames.some(name => !ctx.tools.get(name, agent))) {
      return { available: false, reason: "当前会话未加载官方 Schedule。请启用随包提供的 schedule.patch.yml，并重新打开管家会话。", items: [] };
    }
    const records = await native(scope, "schedule_list", {}, signal) as unknown as ScheduleView[];
    const binding = current().binding;
    const items: RoutineItem[] = [];
    for (const record of records) {
      const data = decode(record);
      if (data && data.sessionId === binding.sessionId && data.cwd === binding.cwd) {
        const parts = new Intl.DateTimeFormat("en", { timeZone: data.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
        const part = (type: string) => parts.find(part => part.type === type)!.value;
        const date = `${part("year")}-${part("month")}-${part("day")}`;
        const day = Date.parse(`${date}T00:00:00Z`);
        items.push({ id: record.id, kind: data.kind, scheduledAt: record.scheduledAt, state: record.state, currentScope: data.scope === scope,
          timeZone: data.timeZone, date, ...(data.kind === "weekly-report" ? { startDate: new Date(day - 7 * 86400000).toISOString().slice(0, 10), endDate: new Date(day - 86400000).toISOString().slice(0, 10) } : {}) });
      }
    }
    return { available: true, items };
  }
  return {
    allows(exec: Pick<ToolExecution, "callId" | "agent" | "name">) {
      const permit = permits.get(exec.callId);
      return !!permit && exec.agent === permit.agent && exec.name === permit.name
        && current().binding.sessionId === permit.agent.id && current().binding.cwd === permit.agent.session.header.cwd
        && vaultScope(current().vault) === permit.scope;
    },
    list,
    set(scope: string, kind: RoutineKind, enabled: boolean, timeZone: string, signal: AbortSignal): Promise<RoutineStatus> {
      const work = tail.then(async () => {
        if (!Object.hasOwn(intervals, kind) || typeof enabled !== "boolean") throw new Error("Invalid routine setting");
        if (enabled) {
          if (!timeZone || timeZone.length > 100) throw new Error("Invalid routine timezone");
          new Intl.DateTimeFormat("en", { timeZone });
        }
        const state = await list(scope, signal);
        if (!state.available) throw new Error(state.reason);
        const existing = state.items.filter(item => item.kind === kind && item.currentScope);
        if (enabled && !existing.length) await native(scope, "schedule_create", { prompt: payload(scope, kind, timeZone), every_seconds: intervals[kind] }, signal);
        if (!enabled) for (const item of existing) await native(scope, "schedule_delete", { id: item.id }, signal);
        return list(scope, signal);
      });
      tail = work.catch(() => {});
      return work;
    },
    async stop(scope: string, id: string, signal: AbortSignal): Promise<RoutineStatus> {
      const state = await list(scope, signal);
      if (!state.items.some(item => item.id === id)) throw new Error("只能暂停本管家的提醒或周报。");
      await native(scope, "schedule_delete", { id }, signal);
      return list(scope, signal);
    },
  };
}
