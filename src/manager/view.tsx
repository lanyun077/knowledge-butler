import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { BookOpen, ChevronRight, Folder, GraduationCap, History, Home, Menu, Moon, RefreshCw, Search, Settings2, SlidersHorizontal, Sun, X } from "lucide-react";
import { HomeModules, ModuleManager, defaultPreferences, loadPreferences, savePreferences, type Preferences } from "./home";
import { StartActions, type Request } from "./actions";
import { KnowledgeWorkspace } from "./knowledge";
import { OrganizeKnowledge } from "./organize";
import { ChangePreview } from "./changes";
import { Disclosure } from "./disclosure";
import { StarMap } from "./star-map";
import { writeReview } from "../knowledge-write-policy";
import { managerSnapshot, managerViews, managerPlan, managerRestore, managerOperationResult, managerPinResult,
  type ManagerInput, type ManagerSnapshot, type ManagerPlan, type ManagerRestore } from "../knowledge-manager-contract";

type View = typeof managerViews[number];
const labels: Record<View, string> = { home: "概览", plans: "待保存方案", sources: "记录", knowledge: "知识", projects: "项目", learning: "学习", activity: "记录", records: "记录", settings: "设置" };
const navigation = [{ view: "home", icon: Home }, { view: "records", icon: History }, { view: "knowledge", icon: BookOpen }, { view: "projects", icon: Folder }, { view: "learning", icon: GraduationCap }, { view: "settings", icon: Settings2 }] as const;
const statuses: Record<string, string> = { pending: "待保存", completed: "已完成", failed: "失败", stale: "版本已变更", cancelled: "已取消", superseded: "已被替代", applying: "正在保存", "needs-reconciliation": "待核对", legacy: "旧方案", Active: "进行中", Done: "已完成", Paused: "已暂停" };
const status = (value: string) => statuses[value] ?? value;
const time = (value?: string) => value ? new Date(value).toLocaleString("zh-CN") : "时间未记录";
type Row = NonNullable<NonNullable<ManagerSnapshot["management"]>["page"]>["items"][number];
type Operation = { kind: "plan"; value: ManagerPlan } | { kind: "restore"; value: ManagerRestore };
const confirmationMessage = (value: string) => ({ accepted: "本次已获确认。", declined: "本次未获确认，未保存。", cancelled: "本次确认已取消，未保存。",
  unchecked: "未勾选同意，未保存。", "already-finished": "返回既有执行结果，未重复执行。", "not-required": "已按你的请求执行。",
  "user-confirmed": "已按你的操作执行。", "full-access": "已按完全访问权限执行。", required: "此修改会删减或大范围覆盖原文，请查看方案后确认保存。" }[value] ?? value);

function Body({ content }: { content: string }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm, remarkFrontmatter]} skipHtml components={{
    a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>〔图片：{alt || "未加载"}〕</span>,
  }}>{content}</Markdown></div>;
}

export function Manager({ app }: { app: App }) {
  const [snapshot, setSnapshot] = useState<ManagerSnapshot>();
  const [organizing, setOrganizing] = useState(false), [preparedRequest, setPreparedRequest] = useState<Request>();
  const [navOpen, setNavOpen] = useState(false), [managing, setManaging] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences), [storageNotice, setStorageNotice] = useState("");
  const themeChoice = useRef<"light" | "dark">(), [theme, setTheme] = useState("light");
  const nav = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const [connection, setConnection] = useState<"connecting" | "connected" | "failed" | "closed">("connecting");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [query, setQuery] = useState("");
  const returnPages = useRef<{ request: ManagerInput; scrollTop: number; path: string }[]>([]);
  const scroll = useRef<HTMLDivElement>(null), scrollAfter = useRef<number | undefined>();
  const [operation, setOperation] = useState<Operation>(), [message, setMessage] = useState(""), [fresh, setFresh] = useState(false);
  const [completedPath, setCompletedPath] = useState<string>();
  const operationOrigin = useRef("");
  const restoreOperationFocus = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null), locked = useRef(false);
  const focusAfter = useRef<string | null>(null);
  const disabled = connection !== "connected" || busy;

  useEffect(() => {
    const theme = (context = app.getHostContext()) => {
      const next = themeChoice.current ?? context?.theme;
      if (next) { document.documentElement.dataset.theme = next; setTheme(next); }
    };
    app.ontoolresult = result => {
      if (locked.current) return;
      if (!result.isError && !managerSnapshot.safeParse(result.structuredContent).success) return;
      try {
        if (result.isError) throw new Error("服务端读取失败，请刷新重试。");
        returnPages.current = [];
        setSnapshot(managerSnapshot.parse(result.structuredContent)); setError("");
      } catch (cause) { setError(String(cause)); }
    };
    app.ontoolcancelled = () => setError("本次读取已取消，可点击刷新重试。");
    app.onhostcontextchanged = theme;
    app.onclose = () => { setConnection("closed"); setError("宿主连接已关闭，请重新展示管家主页。"); };
    void app.connect().then(() => {
      theme();
      if (!app.getHostCapabilities()?.serverTools) throw new Error("宿主未提供界面工具调用，请在聊天中使用文字工具。");
      setConnection("connected");
    }).catch(cause => { setConnection("failed"); setError(`宿主连接失败：${String(cause)}`); });
    return () => { void app.close(); };
  }, [app]);

  useEffect(() => {
    if (!snapshot?.libraryId) return;
    const next = loadPreferences(snapshot.libraryId); setPreferences(next); themeChoice.current = next.theme;
    returnPages.current = [];
    const chosen = next.theme ?? app.getHostContext()?.theme ?? "light";
    document.documentElement.dataset.theme = chosen; setTheme(chosen);
  }, [snapshot?.libraryId, app]);
  useEffect(() => {
    if (!navOpen) return;
    const outside = (event: PointerEvent) => { if (!nav.current?.contains(event.target as Node)) setNavOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setNavOpen(false); menuButton.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    nav.current?.querySelector<HTMLButtonElement>("nav button[aria-current='page'], nav button")?.focus();
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [navOpen]);
  function updatePreferences(next: Preferences) {
    setPreferences(next);
    if (snapshot && !savePreferences(snapshot.libraryId, next)) setStorageNotice("此环境无法记住布局，本次调整仍然有效。");
  }
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    themeChoice.current = next; setTheme(next); document.documentElement.dataset.theme = next;
    updatePreferences({ ...preferences, theme: next });
  }

  useEffect(() => {
    if (!snapshot) return;
    setQuery(snapshot.request.query);
    if (focusAfter.current === null) return;
    const path = focusAfter.current;
    focusAfter.current = null;
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-note-path]")).find(item => item.dataset.notePath === path);
    (button ?? heading.current)?.focus();
    if (scroll.current) scroll.current.scrollTop = scrollAfter.current ?? 0;
    scrollAfter.current = undefined;
  }, [snapshot]);

  async function read(request: ManagerInput, focus: string | null = "", scrollTop = 0) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNavOpen(false);
    try {
      const result = await app.callServerTool({ name: "learning_manager_probe", arguments: { ...request } });
      if (result.isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
      const next = managerSnapshot.parse(result.structuredContent);
      if (!["summary", "detail", "topic"].includes(next.request.view) && focus === "") returnPages.current = [];
      focusAfter.current = focus; scrollAfter.current = scrollTop; setSnapshot(next); setOperation(undefined); setMessage(""); setCompletedPath(undefined);
      return true;
    } catch (cause) { setError(`读取失败，保留上次成功结果。${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { locked.current = false; setBusy(false); }
  }
  async function call(name: string, args: Record<string, unknown>) {
    const result = await app.callServerTool({ name, arguments: args }, { timeout: 300000 });
    if (result.isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
    return result.structuredContent;
  }
  async function run(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setMessage(""); setCompletedPath(undefined);
    try { await work(); }
    catch (cause) {
      setFresh(false);
      setError(`操作未完成或结果待核对：${cause instanceof Error ? cause.message : String(cause)}。请刷新核对当前状态，不会自动重试保存。`);
    } finally { locked.current = false; setBusy(false); }
  }
  function previewPlan(planId: string, revision: number) {
    operationOrigin.current = `plan:${planId}`;
    void run(async () => {
      setOperation({ kind: "plan", value: managerPlan.parse(await call("learning_preview", { planId, revision })) }); setFresh(true);
    });
  }
  function previewRestore(operationId: string) {
    operationOrigin.current = `restore:${operationId}`;
    void run(async () => {
      setOperation({ kind: "restore", value: managerRestore.parse(await call("learning_preview_restore", { operationId })) }); setFresh(true);
    });
  }
  async function refreshSnapshot() {
    const request = snapshot!.request;
    setSnapshot(managerSnapshot.parse(await call("learning_manager_probe", request.view === "detail" ? { view: "detail", path: request.path } : request)));
  }
  function actOnPlan(cancel = false) {
    if (operation?.kind !== "plan") return;
    const { plan, revision } = operation.value;
    void run(async () => {
      const value = managerPlan.parse(await call(cancel ? "learning_cancel" : "learning_request_confirmation", { planId: plan.id, revision, ...(!cancel ? { authorization: "user-confirmed" } : {}) }));
      setOperation({ kind: "plan", value }); setFresh(true);
      if (value.status === "completed") setCompletedPath(value.plan.path);
      setMessage(cancel ? `方案状态：${status(value.status)}。` : `${confirmationMessage(value.confirmation!)} 当前方案：${status(value.status)}。${value.result?.error ?? ""}`);
      await refreshSnapshot();
    });
  }
  function restore() {
    if (operation?.kind !== "restore") return;
    const { operationId } = operation.value;
    void run(async () => {
      const value = managerOperationResult.parse(await call("learning_request_restore", { operationId, authorization: "user-confirmed" }));
      setFresh(false); setMessage(`${confirmationMessage(value.confirmation)} 恢复结果：${status(value.status)}。${value.error ?? ""}`);
      if (value.status === "completed") setCompletedPath(operation.value.path);
      await refreshSnapshot();
    });
  }
  function pin(path: string, pinned: boolean) {
    void run(async () => {
      const value = managerPinResult.parse(await call("learning_pin_project", { path, pinned }));
      setMessage(value.status === "completed" ? pinned ? "项目已置顶。" : "已取消项目置顶。" : confirmationMessage(value.confirmation));
      await refreshSnapshot();
    });
  }
  function closeOperation() {
    restoreOperationFocus.current = true;
    setOperation(undefined); setMessage(""); setCompletedPath(undefined);
  }
  useEffect(() => {
    if (operation) heading.current?.focus();
    else if (restoreOperationFocus.current) {
      restoreOperationFocus.current = false;
      (document.querySelector<HTMLButtonElement>(`button[data-operation="${operationOrigin.current}"]`) ?? heading.current)?.focus();
    }
  }, [operation]);
  async function open(path: string, version?: string, category?: string) {
    const previous = snapshot && { request: snapshot.request, path, scrollTop: scroll.current?.scrollTop ?? 0 };
    if (await read({ view: category === "knowledge" ? "topic" : "summary", path, version }) && previous) returnPages.current.push(previous);
  }
  async function closeDetail() {
    const previous = returnPages.current.at(-1);
    if (await read(previous?.request ?? { view: "home" }, previous?.path ?? "", previous?.scrollTop ?? 0)) returnPages.current.pop();
  }
  function rows(items: Row[], compact = false) {
    if (!items.length) return <div className="empty-state"><p>暂无内容</p></div>;
    return <ul className={`cards${compact ? " compact" : ""}`}>{items.map(item => <li key={"recordId" in item ? item.recordId : "planId" in item ? item.planId : "id" in item ? item.id : item.path}>
      {"recordId" in item ? <>
        <div className="row-title"><h3>{item.title}</h3><span className={`badge ${item.status === "failed" ? "danger" : ""}`}>{item.status === "unrecorded" ? "材料" : status(item.status)}</span></div>
        <p className="excerpt">{item.summary}</p>
        <dl className="record-fields"><dt>保存时间</dt><dd>{time(item.savedAt)}</dd><dt>保存位置</dt><dd>{item.path}</dd><dt>出处</dt><dd>{item.origin ?? item.sourcePath ?? "未记录"}{item.sourceState && item.sourceState !== "版本未变" && <span className="source-state"> · {item.sourceState}</span>}</dd></dl>
        {item.error && <p className="error">{item.error}</p>}
        <div className="row-actions"><button className="text-button" data-note-path={item.path} aria-label={`查看详情：${item.title}`} disabled={disabled} onClick={() => open(item.path)}>查看当前详情<ChevronRight aria-hidden="true" /></button>
          {item.operationKind === "update" && item.status === "completed" && <button className="text-button" data-operation={`restore:${item.operationId}`} disabled={disabled} onClick={() => previewRestore(item.operationId!)}>预览恢复</button>}</div>
      </> : "title" in item ? <>
        <div className="row-title"><h3><button className="row-link" data-note-path={item.path} aria-label={`查看详情：${item.title}`} disabled={disabled} onClick={() => open(item.path, item.version, item.category)}>{item.title}</button></h3>{item.status && <span className="badge">{status(item.status)}</span>}</div>
        <p className="excerpt">{item.progressExcerpt ?? item.excerpt}</p>
        <p className="meta">{({ projects: "项目", learning: "学习目标", knowledge: "知识笔记", inbox: "材料" } as Record<string, string>)[item.category] ?? "笔记"}{item.savedAt && ` · ${time(item.savedAt)}`}</p>
        {item.tasks && item.tasks.total > 0 && <div className="task-progress"><span>已完成任务</span><span>{item.tasks.completed} / {item.tasks.total}</span><progress aria-label={`${item.title}任务完成数`} value={item.tasks.completed} max={item.tasks.total} /></div>}
        {item.metadataError && <p className="error">{item.metadataError}</p>}
        {!compact && <p className="path">{item.path}</p>}
        {item.category === "projects" && !compact && <button className="text-button" disabled={disabled} onClick={() => pin(item.path, !item.pinned)}>{item.pinned ? "取消置顶" : "置顶项目"}</button>}
      </> : "planId" in item ? <>
        <div className="row-title"><h3>{item.action} · {item.path.split("/").pop()?.replace(/\.md$/i, "")}</h3><span className="badge">{status(item.status)}</span></div>
        <p className="excerpt">{item.source ? `来自 ${item.source.path}` : item.path}</p>
        {!compact && <p className="meta">修订 {item.revision} · {time(item.createdAt)}</p>}
        {item.validationError && <p className="error">{item.validationError}</p>}
        <button className="text-button" data-operation={`plan:${item.planId}`} disabled={disabled} onClick={() => previewPlan(item.planId, item.revision)}>查看完整方案<ChevronRight aria-hidden="true" /></button>
      </> : <>
        <div className="row-title"><h3>{item.path}</h3><span className="badge">{status(item.status)}</span></div><p className="meta">{time(item.at)}</p>
        {item.error && <p className="error">{item.error}</p>}
        <div className="row-actions"><button className="text-button" data-note-path={item.path} disabled={disabled} onClick={() => open(item.path)}>查看当前详情</button>
        {item.kind === "update" && item.status === "completed" && <button className="text-button" data-operation={`restore:${item.id}`} disabled={disabled} onClick={() => previewRestore(item.id)}>预览恢复</button>}</div>
      </>}
    </li>)}</ul>;
  }
  function pager(offset: number, total: number, nextOffset: number | null, step: number, onPage: (offset: number) => void, name: string) {
    if (total <= step && offset === 0) return null;
    return <div className="pager" role="group" aria-label={name}>
      <button disabled={disabled || offset === 0} onClick={() => onPage(Math.max(0, offset - step))} aria-label={`上一页${name}`}>上一页</button>
      <span>{total === 0 ? "0 / 0" : `${offset + 1}–${Math.min(offset + step, total)} / ${total}`}</span>
      <button disabled={disabled || nextOffset === null} onClick={() => onPage(nextOffset!)} aria-label={`下一页${name}`}>下一页</button>
    </div>;
  }
  const request = snapshot?.request ?? { view: "home" as const, query: "", offset: 0, historyOffset: 0 };
  const data = snapshot?.management, detail = snapshot?.detail, topic = snapshot?.topic;
  const refresh = request.view === "detail" || request.view === "summary" || request.view === "topic" ? { view: request.view, path: request.path } : request;
  const title = operation ? operation.kind === "plan" ? "完整方案" : "恢复预览" : topic?.title ?? detail?.title ?? labels[request.view as View];
  const currentNav = request.view === "topic" ? "knowledge" : ["sources", "activity", "plans"].includes(request.view) ? "records" : request.view;

  return <main className="manager" aria-busy={busy}>
    <header className="topbar"><div className="brand" ref={nav}>
      <button className="icon-button" ref={menuButton} aria-label="打开导航" aria-expanded={navOpen} aria-controls="manager-navigation" disabled={disabled} onClick={() => setNavOpen(!navOpen)}><Menu aria-hidden="true" /></button>
      <span className="brand-name">知识管家</span><span className="breadcrumb">/　{labels[currentNav as View] ?? "详情"}</span>
      {navOpen && <nav id="manager-navigation" className="navigation" aria-label="管理页面"><p>工作空间</p>{navigation.map(({ view, icon: Icon }) => <button key={view} aria-current={currentNav === view ? "page" : undefined} disabled={disabled} onClick={() => void read({ view })}><Icon aria-hidden="true" />{labels[view]}</button>)}</nav>}
    </div><div className="top-actions">
      <StartActions app={app} disabled={busy} connected={connection === "connected"} view={request.view} preparedRequest={preparedRequest} note={!operation && detail ? { path: detail.path, category: detail.category } : undefined}
        onResults={path => void read({ view: "records", ...(path ? { query: path } : {}) })} />
      <button className={`icon-button${busy ? " refreshing" : ""}`} aria-label={busy ? "正在读取…" : "刷新"} title="刷新" disabled={disabled} onClick={() => operation ? operation.kind === "plan" ? previewPlan(operation.value.plan.id, operation.value.revision) : previewRestore(operation.value.operationId) : void read(refresh, null)}><RefreshCw aria-hidden="true" /></button>
      <button className="icon-button" aria-label={theme === "dark" ? "切换为浅色" : "切换为深色"} title={theme === "dark" ? "切换为浅色" : "切换为深色"} onClick={toggleTheme}>{theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</button>
    </div></header>
    <div className="workspace-scroll" ref={scroll}><div className="workspace">
      <p className="sr-only" role="status">{connection === "connecting" ? "正在连接" : connection === "connected" ? busy ? "正在读取服务端数据" : "宿主连接已建立" : connection === "closed" ? "宿主连接已关闭" : "宿主连接失败"}</p>
      {error && <div role="alert" className="error"><p>{connection === "closed" ? "连接已关闭，请重新展示管家主页。" : connection === "failed" ? "连接未建立，可在聊天中继续查看。" : error.startsWith("读取失败") ? "暂时无法更新，已保留上次内容。" : "操作尚未完成，请刷新核对。"}</p><details><summary>查看原因</summary><p>{error}</p></details></div>}
      {message && <div className="feedback" role="status"><p>{message}</p>{completedPath && <button className="text-button" disabled={disabled} onClick={() => void read({ view: "records", query: completedPath })}>查看保存记录<ChevronRight aria-hidden="true" /></button>}</div>}
      {!snapshot ? <section className="empty-state surface"><h1>正在准备你的空间</h1><p>连接后可刷新；也可以在聊天中继续查看知识库。</p></section> : <>
        <div className="pagehead"><div><h1 ref={heading} tabIndex={-1}>{title}</h1></div>
          {operation || detail || topic ? <button className="icon-button close-detail" aria-label="关闭详情" disabled={disabled} onClick={() => operation ? closeOperation() : closeDetail()}><X aria-hidden="true" /></button>
          : request.view === "knowledge" ? <button disabled={disabled} onClick={() => setOrganizing(true)}>整理知识</button>
          : request.view === "home" && <button disabled={disabled} onClick={() => setManaging(true)}><SlidersHorizontal aria-hidden="true" />管理模块</button>}
        </div>
        {operation ? <section className="surface operation-detail" aria-label={operation.kind === "plan" ? "完整方案预览" : "完整恢复预览"}>
          <p className="path">{operation.kind === "plan" ? operation.value.plan.path : operation.value.path}</p>
          {operation.kind === "plan" ? <>
            <div className="detail-meta"><span className="badge">{status(operation.value.status)}</span><span>修订 {operation.value.revision}</span><span>{operation.value.plan.knowledge ? "知识整理" : operation.value.plan.correction ? "纠正已有知识" : operation.value.plan.create ? "新建" : operation.value.plan.inbox ? "追加" : "修改"}</span></div>
            {operation.value.plan.inbox && <p className="excerpt">来源：{operation.value.plan.inbox.path}<br />理由：{operation.value.plan.inbox.reason}</p>}
            {operation.value.plan.knowledge && <><p className="meta">{operation.value.plan.knowledge.sources.length} 个来源</p>
              <Disclosure title="整理来源">{operation.value.plan.knowledge.sources.map(source => <button key={source.path} className="text-button" onClick={() => open(source.path)}>{source.path}<ChevronRight aria-hidden="true" /></button>)}</Disclosure>
              {operation.value.plan.knowledge.issues.length > 0 && <details><summary>待补充 {operation.value.plan.knowledge.issues.length} 项</summary>{operation.value.plan.knowledge.issues.map((issue, i) => <p className="excerpt" key={i}>{issue.reason}</p>)}</details>}</>}
            {operation.value.validationError && <p className="error">{operation.value.validationError}</p>}
            {operation.value.plan.correction?.changes.map((change, index) => <div key={index}><h2>替换 {index + 1} · 原结论</h2><pre>{change.before}</pre><h2>采用结论</h2><pre>{change.after || "（删除）"}</pre></div>)}
            {!operation.value.plan.correction && <ChangePreview key={`${operation.value.plan.id}:${operation.value.revision}`} before={operation.value.plan.before} after={operation.value.plan.after} />}
            {writeReview(operation.value.plan) && <p className="feedback">{writeReview(operation.value.plan)}。请核对以上修改，点击确认后直接保存。</p>}
            <div className="actions"><button className="primary" disabled={disabled || !fresh || operation.value.status !== "pending"} onClick={() => actOnPlan()}>{writeReview(operation.value.plan) ? "确认修改并保存" : "保存"}</button>
              <button disabled={disabled || !fresh || operation.value.status !== "pending"} onClick={() => actOnPlan(true)}>取消此方案</button></div>
          </> : <>
            <ChangePreview key={operation.value.version} before={operation.value.before} after={operation.value.after} />
            <p className="feedback">恢复会覆盖当前正文。核对后点击即可恢复。</p>
            <div className="actions"><button className="primary" disabled={disabled || !fresh} onClick={restore}>确认恢复</button></div>
          </>}
        </section> : topic ? <KnowledgeWorkspace topic={topic} theme={theme} app={app} disabled={disabled} offset={request.offset ?? 0}
          onPage={offset => void read({ ...request, offset, version: topic.version }, null, scroll.current?.scrollTop ?? 0)} organize={() => setOrganizing(true)} /> : detail ? <>
          <section className="surface" aria-label={request.view === "detail" ? "正文详情" : "文章概况"}><p className="path">{detail.path}</p>
            {detail.reuse.metadataError && <p className="error">{detail.reuse.metadataError}</p>}
            {request.view === "detail" ? <><Body content={detail.content} />{pager(detail.offset, detail.total, detail.nextOffset, 8000, offset => void read({ ...request, offset, version: detail.version }), "正文")}</>
              : <><p className="excerpt">{detail.summary || "暂无概况，请打开原文阅读。"}</p>{detail.openUri && <button onClick={async () => {
                try { const result = await app.openLink({ url: detail.openUri! }); setMessage(result.isError ? "暂时无法打开，请复制文章路径在 Obsidian 查找。" : ""); }
                catch { setMessage("暂时无法打开，请复制文章路径在 Obsidian 查找。"); }
              }}>在 Obsidian 打开</button>}</>}
          </section>
          {(detail.provenance.history.length > 0 || detail.relatedPlans.some(plan => !["completed", "cancelled", "superseded"].includes(plan.status))) && <section className="surface" aria-label="保存记录与出处"><h2>保存记录与出处</h2>
            {detail.provenance.history.map(entry => <article className="provenance-entry" key={entry.planId}>
              <p>{({ create: "新建", append: "追加", correct: "纠正", update: "修改" } as Record<string, string>)[entry.action] ?? entry.action} · {time(entry.savedAt)}</p>
              {!entry.matchesCurrent && <p className="meta">历史版本</p>}
              {entry.source && <><p>出处：{entry.source.path}{entry.source.state !== "unchanged" && ` · ${{ changed: "来源已修改", missing: "来源已缺失" }[entry.source.state]}`}</p><p className="excerpt">{entry.source.reason}</p>
                <button className="text-button" data-note-path={entry.source.path} disabled={disabled || entry.source.state === "missing"} onClick={() => open(entry.source!.path)}>查看来源<ChevronRight aria-hidden="true" /></button></>}
              {entry.sources?.some(source => source.state !== "unchanged") && <p className="meta">{entry.sources.filter(source => source.state === "changed").length > 0 && "部分来源已修改"}{entry.sources.some(source => source.state === "changed") && entry.sources.some(source => source.state === "missing") && " · "}{entry.sources.some(source => source.state === "missing") && "部分来源已缺失"}</p>}
              {entry.sources && <Disclosure title={`整理来源 · ${entry.sources.length} 项`}>{entry.sources.map(source => <div key={source.path}>
                {source.state !== "unchanged" && <p className="error">{source.state === "changed" ? "来源已修改" : "来源已缺失"}</p>}
                <button className="text-button" data-note-path={source.path} disabled={disabled || source.state === "missing"} onClick={() => open(source.path)}>{source.path}<ChevronRight aria-hidden="true" /></button>
                <Disclosure title="引用片段">{source.evidence.map((ref, i) => <p className="excerpt" key={i}>{ref.preview}{ref.truncated && "…"}</p>)}</Disclosure>
              </div>)}</Disclosure>}
              {entry.issues?.length ? <p className="meta">保存时有 {entry.issues.length} 项待补充，详见笔记。</p> : null}
              {!!entry.changes?.length && <Disclosure title="查看纠正内容">{entry.changes.map((change, index) => <ChangePreview key={index} before={change.before} after={change.after} />)}</Disclosure>}
            </article>)}
            {pager(request.historyOffset, detail.provenance.total, detail.provenance.nextOffset, 1, historyOffset => void read({ ...request, historyOffset, version: detail.version }), "来源记录")}
            {detail.relatedPlans.some(plan => !["completed", "cancelled", "superseded"].includes(plan.status)) && <Disclosure title="未完成方案">{rows(detail.relatedPlans.filter(plan => !["completed", "cancelled", "superseded"].includes(plan.status)))}</Disclosure>}
          </section>}
        </> : <>
          {data?.home && <>
            {preferences.order.length ? <HomeModules home={data.home} preferences={preferences} disabled={disabled} renderRows={rows} navigate={view => void read({ view })} /> : <section className="empty-state surface"><h2>留一点空间给重要的事</h2><p>在管理模块中选择你想看到的内容。</p><button onClick={() => setManaging(true)}>管理模块</button></section>}
            {data.home.missingPins.map(path => <p className="error" key={path}>项目暂不可用：{path} <button disabled={disabled} onClick={() => pin(path, false)}>取消缺失项目置顶</button></p>)}
          </>}
          {data?.page && <>
            {request.view === "knowledge" && connection === "connected" && <StarMap key={snapshot.readAt} app={app} theme={theme} />}
            {["records", "plans"].includes(request.view) && <div className="view-tabs" aria-label="记录类型"><button aria-current={request.view === "records" ? "page" : undefined} disabled={disabled} onClick={() => void read({ view: "records" })}>保存记录</button><button aria-current={request.view === "plans" ? "page" : undefined} disabled={disabled} onClick={() => void read({ view: "plans" })}>待保存方案</button></div>}
            {request.view !== "knowledge" && <section className="surface" aria-label={`${labels[data.view]}列表`} data-category={currentNav}>
              <form className="filter" onSubmit={event => { event.preventDefault(); void read({ view: data.view, query }); }}><Search aria-hidden="true" /><label className="sr-only" htmlFor="manager-filter">筛选{labels[data.view]}</label><input id="manager-filter" placeholder={`搜索${labels[data.view]}`} value={query} maxLength={500} disabled={disabled} onChange={event => setQuery(event.target.value)} /><button disabled={disabled} type="submit">筛选</button></form>
              {data.page.items.length ? rows(data.page.items) : <div className="empty-state"><p>{request.query ? "没有找到匹配的内容" : request.view === "plans" ? "暂时没有待保存方案" : "这里还没有内容"}</p><span>{request.query ? "试试更短的关键词，或清空筛选。" : request.view === "plans" ? "" : "从右上角“新建”开始，在聊天中保存资料或建立学习目标。"}</span>{request.query && <button disabled={disabled} onClick={() => void read({ view: request.view })}>清空筛选</button>}</div>}{pager(request.offset, data.page.total, data.page.nextOffset, 10, offset => void read({ ...request, offset }), "列表")}
            </section>}
          </>}
          {data?.settings && <>
            <section className="surface" aria-label="显示设置"><h2>显示</h2><div className="setting-row"><div><h3>首页模块</h3><p className="meta">添加、移除与拖动排序</p></div><button onClick={() => setManaging(true)}>管理模块</button></div><div className="setting-row"><h3>外观</h3><button onClick={toggleTheme}>{theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}{theme === "dark" ? "浅色" : "深色"}</button></div>{storageNotice && <p className="feedback">{storageNotice}</p>}</section>
            <section className="surface" aria-label="只读设置"><h2>知识库</h2><dl className="record-fields">{Object.entries(data.settings.folders).map(([key, value]) => <div className="mapping-row" key={key}><dt>{({ inbox: "材料", knowledge: "知识", projects: "项目", learning: "学习", daily: "日记" } as Record<string, string>)[key] ?? key}</dt><dd>{value}</dd></div>)}</dl><h3>项目绑定</h3>{data.settings.projects.length ? data.settings.projects.map(project => <p className="meta" key={project.directory}>{project.directory} → {project.projectPath}</p>) : <p className="muted">暂无项目绑定。</p>}
              <h3>提醒与周报</h3><p className="meta">在 Codex 原生设置中管理，可在聊天中获取指引。</p><details className="technical"><summary>连接信息</summary><p>知识库：{data.settings.service.vaultId}<br />服务：{data.settings.service.instanceId}<br />状态：{data.settings.service.stopping ? "正在停止" : "可用"} · 待保存 {data.settings.service.pending}<br />{snapshot.resourceVersion}</p></details>
            </section>
          </>}
        </>}
      </>}
    </div></div>
    {managing && <ModuleManager preferences={preferences} update={updatePreferences} close={() => setManaging(false)} storageNotice={storageNotice} />}
    {organizing && <OrganizeKnowledge key={`${snapshot?.libraryId}:${topic?.path ?? "new"}`} app={app} libraryId={snapshot?.libraryId} topicPath={topic?.path} close={() => setOrganizing(false)} prepare={setPreparedRequest} />}
  </main>;
}
