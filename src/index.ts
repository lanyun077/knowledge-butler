import z from "@deepseek-ai/schemastery";
import type { Context, Volatile } from "@deepseek-ai/cordis";
import type { HostConnectionHandle, ConnectionRpcResult } from "@deepseek-ai/dsh-client-connection";
import { sharedVault } from "./knowledge-client";
import type { SharedVault } from "./knowledge-host";
import { defaultFolders, defaultObsidian, vaultScope, type VaultConfig } from "./business-api";
import { assistantTools } from "./assistant-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { ObsidianBridge, type ObsidianConfig } from "./obsidian";
import { assistantDaily } from "./assistant-daily";
import { assistantRoutines, type RoutineKind } from "./routines";
import { dueReviews } from "./due-reviews";
import type { SavedBinding } from "./workspace";
import { prepareArticle } from "./article-source";
import { preparePdf } from "./pdf-source";
import { knowledgeCollectInput, knowledgeQueryInput } from "./knowledge-organization-contract";
import { knowledgePlanInput } from "./knowledge-synthesis";

export interface Config { binding: Volatile<SavedBinding>; vault: Volatile<VaultConfig>; obsidian?: Volatile<ObsidianConfig>; knowledgeConnection?: string }

// Host-local paths are configuration, not portable Vault identity.
export const Config = z.object({
  knowledgeConnection: z.string().default(""),
  obsidian: z.object({
    baseUrl: z.string().default(defaultObsidian.baseUrl),
    apiKeyRef: z.string().role("credential-ref").default(defaultObsidian.apiKeyRef),
  }).default(defaultObsidian).volatile(),
  binding: z.object({
    cwd: z.string().default(""),
    sessionId: z.string().default(""),
    conversations: z.array(z.object({ cwd: z.string(), sessionId: z.string() })).default([]),
  }).default({ cwd: "", sessionId: "" }).volatile(),
  vault: z.object({
    root: z.string().default(""),
    folders: z.object({
      inbox: z.string().default(defaultFolders.inbox),
      knowledge: z.string().default(defaultFolders.knowledge),
      daily: z.string().default(defaultFolders.daily),
      projects: z.string().default(defaultFolders.projects),
      learning: z.string().default(defaultFolders.learning),
    }).default(defaultFolders),
  }).default({ root: "", folders: defaultFolders }).volatile(),
});

export const name = "dsh-learning-os";
export const inject = ["connection", "tools", "agents", "systemPrompt", "credentials"];

function field(payload: Record<string, unknown>, key: string, max = 4096): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${key}`);
  return value;
}

export function apply(ctx: Context, config: Config): void {
  const connection: HostConnectionHandle = ctx.connection;
  const vaults = new Map<string, SharedVault>();
  const getVault = (scope: string) => {
    const current = config.vault.get();
    if (!current.root.trim() || vaultScope(current) !== scope) throw new Error("Vault configuration changed");
    let vault = vaults.get(scope);
    if (!vault) {
      vault = sharedVault(config.knowledgeConnection ?? "", current, () => {
        if (vaultScope(config.vault.get()) !== scope) throw new Error("Vault configuration changed");
      });
      vaults.set(scope, vault);
    }
    return vault;
  };
  const getObsidian = (scope: string, key?: string) => {
    const settings = config.obsidian?.get() ?? defaultObsidian;
    return new ObsidianBridge(getVault(scope), settings, async () =>
      key ?? (await ctx.credentials.resolve(credentialRef(settings.apiKeyRef)))?.value, () => {
      if (vaultScope(config.vault.get()) !== scope || JSON.stringify(config.obsidian?.get() ?? defaultObsidian) !== JSON.stringify(settings)) {
        throw new Error("Obsidian 或资料设置已变化，请重试。");
      }
    });
  };
  const daily = assistantDaily(() => ({ vault: config.vault.get(), binding: config.binding.get() }), getVault);
  const routines = assistantRoutines(ctx, () => ({ vault: config.vault.get(), binding: config.binding.get() }));
  const prepareAssistant = assistantTools(ctx, config, getVault, async (scope, path, signal) => {
    const value = await getObsidian(scope).metadata(path, signal);
    return value;
  }, daily.propose, daily.proposeProject, daily.proposeGoalEvidence, daily.proposeInbox, daily.proposeLearningGoal, daily.proposeReport, daily.proposeGoalSteps, daily.proposeGoalTask, daily.proposeProjectStatus, daily.proposeGoalRecall,
  { routines, proposeGoalReviewDate: daily.proposeGoalReviewDate, proposeCorrection: daily.proposeCorrection, reviseCorrection: daily.reviseCorrection });
  async function handle(endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<unknown>> {
    try {
      signal.throwIfAborted();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid request");
      const data = payload as Record<string, unknown>;
      const current = config.vault.get();
      if (!current.root.trim()) throw new Error("请先设置资料目录。");
      const scope = vaultScope(current);
      if (field(data, "scope", 32768) !== scope) throw new Error("资料目录设置已变化，请刷新后重新操作。");
      const vault = getVault(scope);
      let value: unknown;
      switch (endpoint) {
        case "plan-knowledge": value = await vault.planKnowledge(knowledgePlanInput.parse(data.input), signal); break;
        case "knowledge-collect": value = await vault.collectKnowledge(knowledgeCollectInput.parse(data.input), signal); break;
        case "knowledge-query": value = await vault.queryKnowledge(knowledgeQueryInput.parse(data.input), signal); break;
        case "management": {
          const offset = data.offset ?? 0;
          if (typeof offset !== "number") throw new Error("Invalid offset");
          value = await vault.management(field(data, "view", 30) as import("./knowledge-management").ManagementView, typeof data.query === "string" ? data.query : "", offset, signal); break;
        }
        case "inspect-plan": value = await vault.inspectPlan(field(data, "planId", 100)); break;
        case "pin-project": {
          if (typeof data.pinned !== "boolean") throw new Error("Invalid pin setting");
          value = await vault.setProjectPinned(field(data, "path"), data.pinned); break;
        }
        case "preview-restore": value = await vault.previewRestore(field(data, "operationId", 100)); break;
        case "provenance": {
          const offset = data.offset ?? 0;
          if (typeof offset !== "number") throw new Error("Invalid provenance offset");
          value = await vault.provenance(field(data, "path"), field(data, "version", 64), offset, signal); break;
        }
        case "due-reviews": {
          const offset = data.offset ?? 0;
          if (typeof offset !== "number") throw new Error("Invalid offset");
          value = await dueReviews(vault, field(data, "date", 10), offset, signal); break;
        }
        case "plan-goal-review-date": {
          const date = data.date === null ? null : field(data, "date", 10);
          value = await vault.planGoalReviewDate(field(data, "path"), field(data, "version", 64), date); break;
        }
        case "routines":
        case "routine-set":
        case "routine-stop": {
          const binding = config.binding.get();
          if (field(data, "sessionId", 200) !== binding.sessionId || field(data, "cwd") !== binding.cwd) throw new Error("管家会话已变化，请刷新后操作。");
          prepareAssistant(scope);
          if (endpoint === "routines") value = await routines.list(scope, signal);
          else if (endpoint === "routine-stop") value = await routines.stop(scope, field(data, "id", 200), signal);
          else {
            const kind = field(data, "kind", 30);
            if (!["review-reminder", "weekly-report"].includes(kind) || typeof data.enabled !== "boolean") throw new Error("Invalid routine setting");
            value = await routines.set(scope, kind as RoutineKind, data.enabled, field(data, "timeZone", 100), signal);
          }
          break;
        }
        case "service-status": value = await vault.status(); break;
        case "project-context": value = await vault.projectContext(config.binding.get().cwd); break;
        case "handoff-template": value = await vault.handoffTemplate(); break;
        case "capture-handoff": value = await vault.captureHandoff(field(data, "content", 2_000_000), config.binding.get().cwd, signal); break;
        case "capture-handoff-file": value = await vault.captureHandoffFile(config.binding.get().cwd, field(data, "path"), signal); break;
        case "pending-plans": value = await vault.listPlans(); break;
        case "preview-plan": value = await vault.previewPlan(field(data, "planId", 100)); break;
        case "prepare-assistant": await vault.status(); value = prepareAssistant(scope); break;
        case "assistant-daily-preview":
        case "assistant-daily-cancel":
        case "assistant-daily-confirm":
        case "assistant-project-preview":
        case "assistant-project-cancel":
        case "assistant-project-confirm":
        case "assistant-goal-preview":
        case "assistant-goal-cancel":
        case "assistant-goal-confirm":
        case "assistant-inbox-preview":
        case "assistant-inbox-cancel":
        case "assistant-inbox-confirm":
        case "assistant-report-preview":
        case "assistant-report-cancel":
        case "assistant-report-confirm":
          value = await daily.review({ planId: field(data, "planId", 100), scope,
            sessionId: field(data, "sessionId", 200), cwd: field(data, "cwd") },
          endpoint.endsWith("-preview") ? "preview" : endpoint.endsWith("-cancel") ? "cancel" : "confirm", signal,
          endpoint.startsWith("assistant-report-") ? "report" : endpoint.startsWith("assistant-inbox-") ? "inbox" : endpoint.startsWith("assistant-goal-") ? "goal" : endpoint.startsWith("assistant-project-") ? "project" : "daily");
          break;
        case "obsidian-status": value = await getObsidian(scope).status(signal); break;
        case "obsidian-connect": {
          const key = field(data, "key", 512).trim();
          const settings = config.obsidian?.get() ?? defaultObsidian;
          const ref = credentialRef(settings.apiKeyRef);
          value = await getObsidian(scope, key || undefined).status(signal);
          if (key) await ctx.credentials.set(ref, key);
          break;
        }
        case "obsidian-metadata": value = await getObsidian(scope).metadata(field(data, "path"), signal); break;
        case "obsidian-open": value = await getObsidian(scope).open(field(data, "path"), signal); break;
        case "list": value = await vault.list(field(data, "query")); break;
        case "read": value = await vault.read(field(data, "path")); break;
        case "capture": value = await vault.capture(field(data, "title", 200), field(data, "content", 2_000_000)); break;
        case "plan-article-import": {
          const kind = field(data, "kind", 20);
          if (kind !== "url" && kind !== "markdown") throw new Error("Invalid article kind");
          const title = field(data, "title", 200);
          const source = await prepareArticle({ kind, title, sourceName: field(data, "sourceName", 500),
            url: field(data, "url", 2048), content: field(data, "content", 2_000_000) }, signal);
          signal.throwIfAborted();
          getVault(scope);
          const preview = await vault.planArticleImport(title, source);
          if (signal.aborted || vaultScope(config.vault.get()) !== scope) {
            if (preview.plan) await vault.cancelPlan(preview.plan.id);
            throw new Error("资料目录设置已变化或请求已取消，请重新预览。");
          }
          value = preview;
          break;
        }
        case "read-pdf": value = await vault.readPdf(field(data, "path"), field(data, "version", 64)); break;
        case "plan-pdf-import": {
          const title = field(data, "title", 200);
          const source = await preparePdf({ title, sourceName: field(data, "sourceName", 500), base64: field(data, "base64", 6_666_668) }, signal);
          signal.throwIfAborted();
          getVault(scope);
          const preview = await vault.planPdfImport(title, source);
          if (signal.aborted || vaultScope(config.vault.get()) !== scope) {
            if (preview.plan) await vault.cancelPlan(preview.plan.id);
            throw new Error("资料目录设置已变化或请求已取消，请重新预览。");
          }
          value = preview;
          break;
        }
        case "plan-chat-import": value = await vault.planChatImport({ title: field(data, "title", 200), sourceName: field(data, "sourceName", 500), content: field(data, "content", 2_000_000) }); break;
        case "cancel-plan": {
          const planId = field(data, "planId", 100);
          if (await daily.owns(scope, planId)) throw new Error("请通过管家方案卡片取消。");
          await vault.cancelPlan(planId); break;
        }
        case "plan-update": value = await vault.planUpdate(field(data, "path"), field(data, "version", 64), field(data, "content", 2_000_000)); break;
        case "plan-daily-append": value = await vault.planDailyAppend(field(data, "date", 10), field(data, "content", 2_000_000)); break;
        case "plan-project-append": value = await vault.planProjectAppend(field(data, "path"), field(data, "version", 64), field(data, "content", 2_000_000)); break;
        case "plan-project-status": value = await vault.planProjectStatus(field(data, "path"), field(data, "version", 64), field(data, "status", 20)); break;
        case "plan-learning-goal": value = await vault.planLearningGoal({
          title: field(data, "title", 200), purpose: field(data, "purpose", 100_000), background: field(data, "background", 100_000),
          outcome: field(data, "outcome", 100_000), schedule: field(data, "schedule", 1000),
          targetDate: field(data, "targetDate", 10), verification: field(data, "verification", 100_000),
        }); break;
        case "execute": {
          const planId = field(data, "planId", 100);
          if (await daily.owns(scope, planId)) throw new Error("请通过管家方案卡片预览并确认。");
          value = await vault.execute(planId); break;
        }
        case "restore": value = await vault.restore(field(data, "operationId", 100)); break;
        case "activity": value = await vault.activity(); break;
        default: throw new Error("Unknown learning workspace method");
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: { code: "learning-os/operation-failed", message: error instanceof Error ? error.message : String(error), details: {} } };
    }
  }
  // Shared /api applies the host's authentication and origin checks before dispatch.
  // Each registration is owned and disposed by the calling plugin's context.
  for (const endpoint of ["plan-knowledge", "knowledge-collect", "knowledge-query", "management", "inspect-plan", "pin-project", "preview-restore", "provenance", "project-context", "handoff-template", "capture-handoff", "capture-handoff-file", "service-status", "pending-plans", "preview-plan", "plan-pdf-import", "read-pdf", "plan-article-import", "plan-chat-import", "cancel-plan", "due-reviews", "plan-goal-review-date", "routines", "routine-set", "routine-stop", "prepare-assistant", "assistant-daily-preview", "assistant-daily-cancel", "assistant-daily-confirm", "assistant-project-preview", "assistant-project-cancel", "assistant-project-confirm", "assistant-goal-preview", "assistant-goal-cancel", "assistant-goal-confirm", "assistant-inbox-preview", "assistant-inbox-cancel", "assistant-inbox-confirm", "assistant-report-preview", "assistant-report-cancel", "assistant-report-confirm", "obsidian-status", "obsidian-connect", "obsidian-metadata", "obsidian-open", "list", "read", "capture", "plan-update", "plan-daily-append", "plan-project-append", "plan-project-status", "plan-learning-goal", "execute", "restore", "activity"]) {
    connection.fetch.register({
      path: `/api/learning-os/${endpoint}`,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        let envelope: unknown;
        try { envelope = await request.json(); }
        catch { return new Response("Invalid JSON request", { status: 400 }); }
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
          return new Response("Invalid RPC envelope", { status: 400 });
        }
        const data = envelope as Record<string, unknown>;
        if (data.type !== "client-request" || typeof data.rpcId !== "string" || !data.rpcId.length
          || data.rpcId.length > 200 || data.method !== `learning-os/${endpoint}` || !Object.hasOwn(data, "payload")) {
          return new Response("Invalid RPC envelope: expected matching method, rpcId and payload", { status: 400 });
        }
        const result = await handle(endpoint, data.payload, request.signal);
        return Response.json({ type: "server-response", rpcId: data.rpcId, result });
      },
    });
  }
}
