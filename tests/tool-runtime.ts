import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Scope } from "@deepseek-ai/dsh-scope";
import SessionStore, { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { registerScheduleTools } from "@deepseek-ai/dsh-schedule";

export async function toolRuntime(cwd: string, scheduleSeed?: readonly SessionEvent[], sessionId = "learning-session") {
  const ctx = new Context();
  const prompt = ctx.plugin(SystemPrompt, {});
  await prompt.await();
  const tools = ctx.plugin(ToolRuntime);
  await tools.await();
  const agent = { id: sessionId, session: { header: { cwd } } } as Agent;
  const sessions = scheduleSeed ? ctx.plugin(SessionStore) : undefined;
  if (sessions) {
    await sessions.await();
    Object.assign(agent, { session: ctx.sessions.create(SessionId(agent.id), { meta: { cwd }, seed: scheduleSeed }) });
    ctx.on("session/flush", async () => {});
  }
  let scope!: Scope;
  const minter = ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent);
    Object.assign(agent, { ctx: scope.ctx });
  }, { inject: ["tools", "systemPrompt"] }));
  await minter.await();
  ctx.provide("agents", { get: (id: string) => id === agent.id ? agent : undefined } as never);
  const owner = ctx.plugin(Object.assign(() => {}, { inject: ["tools", "systemPrompt", "agents"] }));
  await owner.await();
  const releaseSchedule = scheduleSeed ? registerScheduleTools(ctx, agent.ctx, agent, () => {}) : undefined;
  return { ctx: owner.ctx, agent, unload: () => owner.dispose(), async dispose() {
    releaseSchedule?.();
    await owner.dispose(); await scope.dispose(); await minter.dispose();
    await tools.dispose(); await prompt.dispose();
    await sessions?.dispose();
  } };
}
