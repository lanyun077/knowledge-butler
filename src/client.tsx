import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-tool/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type { InjectFace, PropsRenderFactories, PropsRenderSlots, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { createWorkspace, pages, type Workspace } from "./workspace";
import { createNavigation, type Navigation } from "./navigation";
import css from "./styles.css";
import businessCss from "./business.css";
import { BusinessPanel } from "./business-panel";
import { businessApi, defaultFolders, vaultScope, type VaultConfig, type PlainConfig } from "./business-api";
import { NoteToolView } from "./note-tool-view";
import { DailyToolView, dailyFace } from "./daily-tool-view";
import { ObsidianConnection } from "./obsidian-connection";
import { DailyManagement } from "./daily-management";
import { ManagementPanel } from "./management-panel";
import type { ObsidianConfig } from "./obsidian";
import { BookOpen, LayoutDashboard, Inbox, Library, FolderKanban, GraduationCap, History, PanelRight, ArrowLeft, Folder, Bot } from "lucide-react";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "learning-os.assistant": { kind: "single"; scope: "session" };
  }
}

export const name = "dsh-learning-os-client";
export const inject = ["slots", "layout", "sessions", "uiConversation", "configForms", "connection"];
const panelId = "dsh-learning-os" as MainPanelId;
const pageIcons = { 概览: LayoutDashboard, Inbox, 知识库: Library, 项目: FolderKanban, 学习: GraduationCap, 日志: History };

function panelFace(workspace: Workspace, navigation: Navigation, form: ConfigForm<PlainConfig>, rpc: ClientConnectionRpc, sessions: ISessions) {
  return {
    hooks: { workspace, configuration: form, sessionCatalog: sessions.list },
    rpc,
    saveVault: (value: VaultConfig) => form.set("vault", value),
    saveObsidian: (value: ObsidianConfig) => form.set("obsidian", value),
    navigate: navigation.navigate,
    openReference: navigation.openReference,
    setDirectory: workspace.setDirectory,
    connect: workspace.connect,
    reference: workspace.reference,
    newConversation: () => workspace.newConversation(),
    selectConversation: (id: string) => workspace.selectConversation(id),
    leave: navigation.leave,
  };
}

type PanelProps = PropsRuntime<"main"> & PropsRenderSlots<"learning-os.assistant"> & InjectFace<ReturnType<typeof panelFace>>;

function WorkspacePanel({ useWorkspace, useConfiguration, useSessionCatalog, rpc, saveVault, saveObsidian, navigate, openReference, setDirectory, connect, reference, newConversation, selectConversation, leave, SessionProvider, renderSlot }: PanelProps) {
  const state = useWorkspace(value => value);
  const catalog = useSessionCatalog(value => value);
  const changing = state.loading || state.connecting;
  const running = catalog.byId[state.sessionId as keyof typeof catalog.byId]?.running;
  const configuration = useConfiguration(value => value);
  const vault = configuration.value?.vault;
  const scope = vault ? vaultScope(vault) : "";
  const api = useMemo(() => vault ? businessApi(rpc, vault) : undefined, [rpc, scope]);
  const session = reference();
  const [resourcesOpen, setResourcesOpen] = useState(!!state.noteReference);
  const resourcesVisible = resourcesOpen;
  const resourcesToggle = useRef<HTMLButtonElement>(null);
  function closeResources() {
    setResourcesOpen(false);
    resourcesToggle.current?.focus();
  }
  useEffect(() => {
    if (state.noteReference) setResourcesOpen(true);
  }, [state.noteReference]);
  useEffect(() => {
    if (state.sessionId && !state.loading) void connect();
  }, [state.sessionId, state.loading, connect, scope]);
  return <section className="learning-os" aria-label="学习空间" data-resources-open={resourcesVisible}>
    <header className="learning-os-header">
      <div className="learning-os-brand"><Bot size={21} /><strong>学习管家</strong></div>
      <div className="learning-os-vault" title={vault?.root}><Folder size={14} /><span>{vault?.root ? vault.root.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) : "未连接资料"}</span></div>
      <div className="learning-os-header-actions">
        <button className="learning-os-home" aria-label="管家" title="回到管家" aria-pressed={!resourcesVisible} onClick={closeResources}><Bot size={16} /><span>管家</span></button>
        <button ref={resourcesToggle} className="learning-os-resources-toggle" aria-expanded={resourcesVisible} aria-controls="learning-resources" onClick={() => resourcesVisible ? closeResources() : setResourcesOpen(true)} title={resourcesVisible ? "收起资料" : "打开资料"}><PanelRight size={16} /><span>资料</span></button>
        <button className="learning-icon-button" aria-label="返回宿主" title="返回宿主" onClick={leave}><ArrowLeft size={17} /></button>
      </div>
    </header>
    <div className="learning-os-body">
      <aside id="learning-resources" className="learning-os-resources" aria-label="资料">
        <nav className="learning-os-navigation" aria-label="学习空间导航">
          {pages.map(page => { const Icon = pageIcons[page]; return <button key={page} aria-current={state.page === page ? "page" : undefined} onClick={() => navigate(page)}><Icon size={16} /><span>{page === "概览" ? "首页" : page}</span></button>; })}
        </nav>
      <div className="learning-os-content">
        <h1 className="learning-sr-only">{state.page}</h1>
        {vault?.root && api ? <>
          {state.page === "概览" && !state.noteReference && <ManagementPanel key={`management:${scope}:${state.sessionId}`} api={api} binding={configuration.value!.binding} scope={scope} writable={configuration.status === "ready" && configuration.mode === "host" && configuration.writable} openReference={openReference}
            settings={<ObsidianConnection key={`obsidian:${scope}`} config={configuration.value?.obsidian} save={saveObsidian} api={api} writable={configuration.status === "ready" && configuration.mode === "host" && configuration.writable} />} />}
          {state.page === "学习" && <DailyManagement key={`daily:${scope}:${state.sessionId}`} api={api} binding={configuration.value!.binding} scope={scope} openReference={openReference} />}
          <div className="learning-business-slot" hidden={state.page === "概览" && !state.noteReference}><BusinessPanel key={scope} draftKey={scope} page={state.page} api={api} noteReference={state.noteReference} /></div>
        </> : <VaultSetup save={saveVault} writable={configuration.status === "ready" && configuration.mode === "host" && configuration.writable} />}
      </div>
      </aside>
      <main id="learning-assistant" className="learning-os-assistant" aria-label="管家">
        <header className="learning-assistant-header"><Bot size={18} /><h2>学习管家</h2><span className="learning-status" data-status={session ? "Active" : "Paused"}>{session ? "已连接" : "未连接"}</span></header>
        {vault?.root && state.conversations.length > 0 && <div className="learning-conversations">
          <label htmlFor="learning-conversation">会话</label>
          <select id="learning-conversation" value={state.sessionId} disabled={changing || running} onChange={event => { void selectConversation(event.target.value); }}>
            {!state.sessionId && <option value="">{state.connecting ? "正在新建…" : "尚未连接"}</option>}
            {state.conversations.map((entry, index) => <option key={entry.sessionId} value={entry.sessionId}>{catalog.byId[entry.sessionId as keyof typeof catalog.byId]?.title || `会话 ${index + 1}`} · {entry.sessionId.slice(-6)}</option>)}
          </select>
          <button disabled={changing || running} onClick={() => { void newConversation(); }}>新建会话</button>
          {running && <span className="learning-conversations-hint">回复完成或停止后可切换</span>}
        </div>}
        {session ? <>
          <p className="learning-os-session" title={state.cwd}>{state.cwd}</p>
          <SessionProvider key={state.sessionId} session={session}>{renderSlot("learning-os.assistant", {})}</SessionProvider>
        </> : !vault?.root ? <div className="learning-os-connect"><BookOpen size={28} /><h2>学习管家</h2><button className="learning-primary" onClick={() => setResourcesOpen(true)}><Folder size={16} />连接资料目录</button></div> : <div className="learning-os-connect">
          <label htmlFor="learning-os-cwd">会话目录</label>
          <input id="learning-os-cwd" value={state.cwd} disabled={state.loading || state.connecting || !!state.sessionId} onChange={event => setDirectory(event.target.value)} placeholder="填写测试目录的绝对路径" />
          <button disabled={state.loading || state.connecting} onClick={() => { void connect(); }}>{state.loading ? "正在读取空间配置…" : state.connecting ? "正在连接…" : state.sessionId ? "重试连接" : "创建会话"}</button>
        </div>}
        {state.error && <p role="alert">{state.error}</p>}
      </main>
    </div>
  </section>;
}

function Assistant({ renderFactorySlot, useSession }: PropsRuntime<"learning-os.assistant"> & PropsRenderFactories) {
  const session = useSession(value => value);
  if (session.openState === "error") return <p role="alert">会话加载失败，请返回宿主检查连接。</p>;
  const settling = session.openState !== "open";
  const blank = session.blank && !session.running && !session.promptAttempted && !session.pendingSubmissions.length;
  return <div className="learning-os-conversation">{renderFactorySlot("conversation.content", {
    variant: "embedded", phase: settling ? "settling" : blank ? "hero" : "active", hero: false,
  })}</div>;
}

function VaultSetup({ save, writable }: { save: (value: VaultConfig) => Promise<boolean>; writable: boolean }) {
  const [root, setRoot] = useState("");
  const [folders, setFolders] = useState(defaultFolders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const labels: Record<keyof typeof defaultFolders, string> = { inbox: "收件箱", knowledge: "知识", daily: "日记", projects: "项目", learning: "学习" };
  return <form className="learning-business learning-os-setup" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError("");
    void save({ root: root.trim(), folders }).then(accepted => {
      if (!accepted) setError("宿主未接受目录设置，请重试。");
    }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
  }}>
    <h2>连接资料目录</h2>
    <label>资料目录<input required value={root} disabled={busy || !writable} onChange={event => setRoot(event.target.value)} placeholder="例如 D:/我的笔记" /></label>
    <details><summary>目录映射</summary>
      {Object.keys(folders).map(value => {
        const key = value as keyof typeof folders;
        return <label key={key}>{labels[key]}<input required value={folders[key]} disabled={busy || !writable} onChange={event => setFolders({ ...folders, [key]: event.target.value })} /></label>;
      })}
    </details>
    <button disabled={busy || !writable || !root.trim()}>{busy ? "正在连接…" : "连接资料目录"}</button>
    {!writable && <p>正在等待宿主提供可保存的目录设置。</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}

export function apply(ctx: Context): void {
  const form = ctx.configForms.get<PlainConfig>("dsh-learning-os");
  const rpc = (ctx.get("connection") as unknown as { rpc: ClientConnectionRpc }).rpc;
  const workspace = createWorkspace(ctx.sessions, binding => form.set("binding", binding), async () => {
    const vault = form.getSnapshot().value?.vault;
    if (!vault?.root.trim()) throw new Error("请先连接资料目录，再连接管家。");
    await businessApi(rpc, vault).prepareAssistant();
  });
  const navigation = createNavigation(window, workspace, open => ctx.layout.selectPanel(open ? panelId : null));
  ctx.effect(() => {
    let lastScope: string | undefined;
    const restore = () => {
      const snapshot = form.getSnapshot();
      if (snapshot.status === "ready" && snapshot.value && snapshot.mode === "host" && snapshot.writable) {
        const scope = snapshot.value.vault ? vaultScope(snapshot.value.vault) : "";
        const state = workspace.getSnapshot();
        if ((lastScope !== undefined && lastScope !== scope) || state.sessionId !== snapshot.value.binding.sessionId || state.cwd !== snapshot.value.binding.cwd) workspace.unavailable();
        lastScope = scope;
        workspace.restore(snapshot.value.binding);
      }
      else if (snapshot.status === "unavailable" || (snapshot.status === "ready" && !snapshot.writable)) workspace.unavailable();
    };
    const unsubscribe = form.subscribe(restore);
    restore();
    return unsubscribe;
  });
  ctx.effect(() => () => workspace.dispose());
  ctx.effect(() => () => navigation.dispose());
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = name;
    style.textContent = css + businessCss;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main", key: panelId,
    children: { "learning-os.assistant": { kind: "single", scope: "session" } },
    inject: () => panelFace(workspace, navigation, form, rpc, ctx.sessions),
  }, WorkspacePanel));
  ctx.slots.inject("learning-os.assistant", () => ctx.slots.register({ name: "learning-os.assistant" }, Assistant));
  ctx.slots.inject("tool.call.toolview", function* () {
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_daily", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_project_progress", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_project_status", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_goal_evidence", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_goal", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_goal_steps", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_goal_task", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_goal_recall", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_goal_review_date", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_inbox", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_correction", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_revise_correction", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "learning_plan_review", inject: () => dailyFace(form, rpc, navigation.openReference) }, DailyToolView);
    for (const key of ["learning_search", "learning_read", "learning_provenance", "learning_obsidian_metadata", "learning_review_period", "learning_due_reviews", "learning_routines"]) yield ctx.slots.register({ name: "tool.call.toolview", key, inject: () => ({ openReference: navigation.openReference }) }, NoteToolView);
  });
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist", id: panelId, label: "学习空间", order: 40,
  }, () => <span aria-hidden="true">学</span>));
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay", id: "learning-os.navigation",
  }, ({ usePanelInfo }: PropsRuntime<"shell.overlay">) => {
    const active = usePanelInfo(info => info.activePanelId === panelId);
    useEffect(() => navigation.observePanel(active), [active]);
    return null;
  }));
  navigation.start();
}
