import type { ISessions, SessionReference } from "@deepseek-ai/dsh-api-session-controller/client";
import type { NoteReference } from "./references";

declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap { learningWorkspace: unknown }
}

export const pages = ["概览", "Inbox", "知识库", "项目", "学习", "日志"] as const;
export type Page = typeof pages[number];
export interface WorkspaceSession { cwd: string; sessionId: string }
export interface SavedBinding extends WorkspaceSession { conversations?: readonly WorkspaceSession[] }

export function workspaceSessions(binding: SavedBinding): WorkspaceSession[] {
  const entries = [...binding.conversations ?? []];
  if (binding.sessionId && !entries.some(item => item.sessionId === binding.sessionId)) {
    entries.push({ cwd: binding.cwd, sessionId: binding.sessionId });
  }
  return entries;
}

export function createWorkspace(
  sessions: Pick<ISessions, "create" | "retain" | "list">,
  saveBinding?: (binding: SavedBinding) => Promise<boolean>,
  prepareAssistant?: () => Promise<void>,
) {
  let state = { page: "概览" as Page, noteReference: undefined as NoteReference | undefined, cwd: "", connecting: false, error: "", sessionId: "", conversations: [] as WorkspaceSession[], loading: !!saveBinding };
  let reference: SessionReference | undefined;
  let pending: SessionReference | undefined;
  let disposed = false;
  let generation = 0;
  let saved = false;
  const release = () => {
    generation++;
    pending?.release();
    reference?.release();
    pending = undefined;
    reference = undefined;
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    listeners.forEach(listener => listener());
  };
  const canSwitch = () => {
    if (disposed || state.loading || state.connecting) return false;
    const snapshot = reference?.binding.session.getSnapshot();
    if (sessions.list.getSnapshot().byId[state.sessionId as SessionReference["sessionId"]]?.running
      || snapshot?.running || snapshot?.pendingSubmissions.length) {
      update({ error: "请等待当前回复完成，或先停止生成，再切换会话。" });
      return false;
    }
    return true;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    navigate(page: Page, noteReference?: NoteReference) { update({ page, noteReference }); },
    restore(binding: SavedBinding) {
      if (disposed) return;
      if (!state.loading) {
        const conversations = workspaceSessions(binding);
        if (JSON.stringify(conversations) !== JSON.stringify(state.conversations)) update({ conversations });
        return;
      }
      saved = true;
      update({ cwd: binding.cwd, sessionId: binding.sessionId, conversations: workspaceSessions(binding), loading: false, error: "" });
    },
    unavailable() {
      if (disposed) return;
      release();
      update({ loading: true, connecting: false, error: "宿主未提供可持久保存的插件配置，暂时无法连接。" });
    },
    setDirectory(cwd: string) {
      if (!state.loading && !state.connecting && !state.sessionId) update({ cwd });
    },
    reference: () => reference,
    async newConversation() {
      if (!canSwitch() || !state.cwd.trim()) return;
      release();
      saved = false;
      update({ sessionId: "", error: "" });
      await this.connect();
    },
    async selectConversation(sessionId: string) {
      if (sessionId === state.sessionId || !canSwitch()) return;
      const selected = state.conversations.find(item => item.sessionId === sessionId);
      if (!selected) return;
      release();
      saved = false;
      update({ ...selected, error: "" });
      await this.connect();
    },
    async connect() {
      if (disposed || state.loading || state.connecting || reference) return;
      if (!state.cwd.trim()) {
        update({ error: "请填写宿主机器上的测试目录。" });
        return;
      }
      update({ connecting: true, error: "" });
      const attempt = generation;
      const current = () => !disposed && attempt === generation;
      try {
        // Explicit-id adoption catalogues restored sessions before retain, including blank sessions.
        const id = await sessions.create({ cwd: state.cwd.trim(),
          ...(state.sessionId ? { sessionId: state.sessionId as SessionReference["sessionId"] } : {}),
        });
        if (!current()) return;
        if (!state.sessionId) saved = false;
        const conversations = workspaceSessions({ cwd: state.cwd.trim(), sessionId: id, conversations: state.conversations });
        update({ sessionId: id, conversations });
        if (!saved && saveBinding) {
          const accepted = await saveBinding({ cwd: state.cwd.trim(), sessionId: id,
            ...(conversations.length > 1 ? { conversations } : {}),
          });
          if (!current()) return;
          if (!accepted) {
            throw new Error("宿主拒绝保存会话绑定，请重试；不会重新创建会话。");
          }
          saved = true;
        }
        if (!current()) return;
        if (prepareAssistant) await prepareAssistant();
        if (!current()) return;
        pending = sessions.retain(id as SessionReference["sessionId"], { source: "learningWorkspace" });
        await pending.ready;
        if (!current()) return;
        reference = pending;
      } catch (error) {
        if (current()) {
          pending?.release();
          update({ error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (current()) {
          pending = undefined;
          update({ connecting: false });
        }
      }
    },
    dispose() {
      disposed = true;
      release();
      listeners.clear();
    },
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;
