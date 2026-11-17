import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadKnowledgeConfig, type KnowledgeConfig } from "./knowledge-config";
import { ensureKnowledgeService } from "./knowledge-launcher";
import { isMappedNotePath, type ChangePlan } from "./vault";
import { planMethods, readMethods, type HostMethod, type HostReply, type HostRequest, type HostVault, type PlanMethod, type SharedVault } from "./knowledge-host";
import type { VaultConfig } from "./business-api";
import type { KnowledgeProposal, ProposalOwner } from "./knowledge-types";

/** Backend-only adapter. No writer or filesystem fallback lives in DSH. */
export function sharedVault(connectionFile: string, expected: VaultConfig, checkCurrent = () => {}): SharedVault {
  const channel = randomUUID();
  const tickets = new Map<string, string>();
  let ready: Promise<KnowledgeConfig> | undefined;
  const connect = () => ready ??= (async () => {
    if (!connectionFile) throw new Error("请在 DSH 宿主配置中设置 knowledgeConnection 共享服务连接文件；不会回退本地写入。");
    const config = await loadKnowledgeConfig(connectionFile);
    const root = await realpath(expected.root);
    const sameRoot = process.platform === "win32" ? root.toLowerCase() === config.vaultRoot.toLowerCase() : root === config.vaultRoot;
    if (!sameRoot || Object.keys(expected.folders).some(key => expected.folders[key as keyof typeof expected.folders] !== config.folders[key as keyof typeof config.folders])) {
      throw new Error("共享服务的 Vault 或目录映射与 DSH 设置不一致。");
    }
    await ensureKnowledgeService(config, connectionFile, fileURLToPath(new URL("../dist/knowledge-launcher.js", import.meta.url)));
    return config;
  })().catch(error => { ready = undefined; throw error; });

  async function request(method: HostMethod, args: unknown[] = [], owner?: ProposalOwner, signal?: AbortSignal): Promise<unknown> {
    checkCurrent();
    signal?.throwIfAborted();
    const config = await connect();
    checkCurrent();
    const id = args[0] as string;
    const payload: HostRequest = { channel, method, args, owner, ticket: method === "execute" ? tickets.get(id) : undefined };
    const response = await fetch(`${config.url}/host`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    const reply = await response.json() as HostReply & { ok: boolean; error?: string; code?: string };
    if (!response.ok || !reply.ok) {
      const error = new Error(reply.error ?? `Knowledge service HTTP ${response.status}`) as NodeJS.ErrnoException;
      error.code = reply.code;
      throw error;
    }
    checkCurrent();
    signal?.throwIfAborted();
    if (reply.ticket) {
      const value = reply.value as ChangePlan | KnowledgeProposal | { plan: ChangePlan };
      const plan = "plan" in value ? value.plan : value;
      tickets.set(plan.id, reply.ticket);
    }
    return reply.value;
  }

  const plans = Object.fromEntries(planMethods.map(method => [method, (...args: unknown[]) => request(method, args)])) as Pick<HostVault, PlanMethod>;
  const reads = {
    list: (query = "", signal?: AbortSignal) => request("list", [query], undefined, signal),
    read: (path: string, signal?: AbortSignal) => request("read", [path], undefined, signal),
    readPdf: (path: string, version: string) => request("readPdf", [path, version]),
    verifyObsidianConnection: (key: string, port: number) => request("verifyObsidianConnection", [key, port]),
  } as Pick<HostVault, typeof readMethods[number]>;
  return {
    ...plans, ...reads,
    planKnowledge: (input, signal) => request("planKnowledge", [input], undefined, signal) as ReturnType<SharedVault["planKnowledge"]>,
    collectKnowledge: (input, signal) => request("collectKnowledge", [input], undefined, signal) as ReturnType<SharedVault["collectKnowledge"]>,
    queryKnowledge: (input, signal) => request("queryKnowledge", [input], undefined, signal) as ReturnType<SharedVault["queryKnowledge"]>,
    saveRequested: (id, revision, authorization, signal) => request("saveRequested", [id, revision, authorization], undefined, signal) as ReturnType<SharedVault["saveRequested"]>,
    management: (view = "home", query = "", offset = 0, signal) => request("management", [view, query, offset], undefined, signal) as ReturnType<SharedVault["management"]>,
    inspectPlan: id => request("inspectPlan", [id]) as ReturnType<SharedVault["inspectPlan"]>,
    setProjectPinned: (path, pinned) => request("setProjectPinned", [path, pinned]) as ReturnType<SharedVault["setProjectPinned"]>,
    previewRestore: id => request("previewRestore", [id]) as ReturnType<SharedVault["previewRestore"]>,
    provenance: (path, version, offset = 0, signal) => request("provenance", [path, version, offset], undefined, signal) as ReturnType<SharedVault["provenance"]>,
    projectContext: directory => request("projectContext", [directory]) as ReturnType<SharedVault["projectContext"]>,
    projectSearch: (query, directory, allProjects = false, signal) => request("projectSearch", [query, directory, allProjects], undefined, signal) as ReturnType<SharedVault["projectSearch"]>,
    handoffTemplate: () => request("handoffTemplate") as Promise<string>,
    captureHandoff: (content, directory, signal) => request("captureHandoff", [content, directory], undefined, signal) as ReturnType<SharedVault["captureHandoff"]>,
    captureHandoffFile: (directory, path, signal) => request("captureHandoffFile", [directory, path], undefined, signal) as ReturnType<SharedVault["captureHandoffFile"]>,
    isMappedNote: path => isMappedNotePath(path, expected.folders),
    capture: (title, content) => request("capture", [title, content]) as ReturnType<HostVault["capture"]>,
    previewPlan: async id => (await request("previewPlan", [id]) as KnowledgeProposal).plan,
    cancelPlan: async id => { await request("cancelPlan", [id]); },
    execute: async (id, check = () => {}) => {
      check();
      const entry = await request("execute", [id]) as KnowledgeProposal;
      check();
      if (!entry.result) throw new Error(entry.validationError ?? `Plan is ${entry.status}; no write result exists`);
      return entry.result;
    },
    activity: () => request("activity") as ReturnType<HostVault["activity"]>,
    restore: id => request("restore", [id]) as ReturnType<HostVault["restore"]>,
    owns: id => request("owns", [id]) as Promise<boolean>,
    listPlans: () => request("listPlans") as Promise<KnowledgeProposal[]>,
    status: () => request("status"),
    async proposeAssistant(owner, method, args, signal) {
      const plan = await request(method, args, owner, signal) as ChangePlan;
      return { planId: plan.id, scope: owner.scope, sessionId: owner.sessionId, cwd: owner.cwd };
    },
    async reviseAssistant(owner, id, revision, input, signal) {
      const entry = await request("reviseCorrection", [id, revision, input], owner, signal) as KnowledgeProposal;
      return { planId: entry.plan.id, revision: entry.revision, scope: owner.scope, sessionId: owner.sessionId, cwd: owner.cwd };
    },
    async reviewAssistant(identity, action, kind, signal) {
      const owner = { scope: identity.scope, sessionId: identity.sessionId, cwd: identity.cwd, kind };
      const entry = await request(action === "preview" ? "previewPlan" : action === "cancel" ? "cancelPlan" : "execute", [identity.planId], owner, signal) as KnowledgeProposal;
      return { plan: entry.plan, status: entry.status, result: entry.result, revision: entry.revision, validationError: entry.validationError };
    },
  };
}
