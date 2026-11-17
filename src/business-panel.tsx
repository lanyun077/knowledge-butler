import type { ArticleImportInput } from "./article-source";
import { ArticleImport, emptyArticle } from "./article-import";
import { PdfImport, PdfOriginalLinks } from "./pdf-import";
import type { PdfImportInput, PdfOriginal } from "./pdf-source";
import { useEffect, useRef, useState } from "react";
import type { Page } from "./workspace";
import type { NoteSummary, NoteDocument, ChangePlan, ChangeResult, ChatImportInput, ChatImportPreview } from "./vault";
import type { LearningGoalInput } from "./note-metadata";
import type { NoteReference } from "./references";
import { Search, RefreshCw, FileText, Plus, CalendarDays, Pencil, ArrowLeft, BookOpen, Code, X, Clock } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { ProgressMeter } from "./progress-meter";

export interface BusinessApi {
  list(query?: string): Promise<NoteSummary[]>;
  read(path: string): Promise<NoteDocument>;
  capture(title: string, content: string): Promise<NoteDocument>;
  planPdfImport(input: PdfImportInput): Promise<ChatImportPreview>;
  readPdf(path: string, version: string): Promise<PdfOriginal>;
  planArticleImport(input: ArticleImportInput): Promise<ChatImportPreview>;
  planChatImport(input: ChatImportInput): Promise<ChatImportPreview>;
  cancelPlan(planId: string): Promise<void>;
  planUpdate(path: string, version: string, content: string): Promise<ChangePlan>;
  planDailyAppend(date: string, content: string): Promise<ChangePlan>;
  planProjectAppend(path: string, version: string, content: string): Promise<ChangePlan>;
  planProjectStatus(path: string, version: string, status: string): Promise<ChangePlan>;
  planLearningGoal(goal: LearningGoalInput): Promise<ChangePlan>;
  execute(planId: string): Promise<ChangeResult>;
  restore(operationId: string): Promise<ChangeResult>;
  previewRestore(operationId: string): ReturnType<import("./vault").VaultService["previewRestore"]>;
  activity(): Promise<ChangeResult[]>;
  openObsidian(path: string): Promise<{ path: string }>;
}

const categories: Partial<Record<Page, string>> = { Inbox: "inbox", 知识库: "knowledge", 项目: "projects", 学习: "learning" };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const statusLabels: Record<string, string> = { Active: "进行中", Paused: "已暂停", Completed: "已完成", Archive: "已归档" };
const emptyGoal: LearningGoalInput = { title: "", purpose: "", background: "", outcome: "", schedule: "", targetDate: "", verification: "" };
const goalLabels: Record<keyof LearningGoalInput, string> = { title: "目标名称", purpose: "学习目的", background: "当前背景", outcome: "预期成果", schedule: "可用时间", targetDate: "目标日期", verification: "验证方式" };

interface Draft {
  title: string;
  captureContent: string;
  chat?: ChatImportInput;
  articleInput?: ArticleImportInput;
  dailyDate: string;
  dailyContent: string;
  projectPath?: string;
  projectContent?: string;
  goal?: LearningGoalInput;
  edit?: { document: NoteDocument; content: string };
}
const storageKey = (key: string) => `dsh-learning-os:draft:${key}`;
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

function loadDraft(key?: string): { draft?: Draft; warning?: string } {
  if (!key) return {};
  try {
    const text = sessionStorage.getItem(storageKey(key));
    if (!text) return {};
    const value = JSON.parse(text) as Draft;
    const note = value?.edit?.document;
    if (!value || typeof value.title !== "string" || typeof value.captureContent !== "string"
      || (value.dailyDate !== undefined && typeof value.dailyDate !== "string")
      || (value.dailyContent !== undefined && typeof value.dailyContent !== "string")
      || (value.projectPath !== undefined && typeof value.projectPath !== "string")
      || (value.projectContent !== undefined && typeof value.projectContent !== "string")
      || (value.articleInput !== undefined && (!value.articleInput || !["url", "markdown"].includes(value.articleInput.kind) || !["title", "sourceName", "url", "content"].every(key => typeof value.articleInput?.[key as keyof ArticleImportInput] === "string")))
      || (value.chat !== undefined && (!value.chat || !["title", "sourceName", "content"].every(key => typeof value.chat?.[key as keyof ChatImportInput] === "string")))
      || (value.goal !== undefined && (!value.goal || !Object.keys(emptyGoal).every(key => typeof value.goal?.[key as keyof LearningGoalInput] === "string")))
      || (value.edit !== undefined && (!note || typeof value.edit.content !== "string"
        || !["path", "title", "category", "excerpt", "content", "version"].every(field => typeof note[field as keyof NoteDocument] === "string")))) {
      throw new Error("Invalid draft data");
    }
    return { draft: value };
  } catch (cause) {
    return { warning: `无法恢复当前标签页草稿，仍可正常读取资料：${message(cause)}` };
  }
}

// The parent keys this component by draftKey when switching Vault configurations.
export function BusinessPanel({ page, api, draftKey, noteReference }: { page: Page; api: BusinessApi; draftKey?: string; noteReference?: NoteReference }) {
  const [restored] = useState(() => loadDraft(draftKey));
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loadedQuery, setLoadedQuery] = useState("");
  const [document, setDocument] = useState<NoteDocument | undefined>(restored.draft?.edit?.document);
  const [editing, setEditing] = useState(!!restored.draft?.edit);
  const [content, setContent] = useState(restored.draft?.edit?.content ?? "");
  const [nextPath, setNextPath] = useState<string>();
  const [nextVersion, setNextVersion] = useState<string>();
  const [plan, setPlan] = useState<ChangePlan>();
  const [title, setTitle] = useState(restored.draft?.title ?? "");
  const [captureContent, setCaptureContent] = useState(restored.draft?.captureContent ?? "");
  const [chat, setChat] = useState<ChatImportInput>(restored.draft?.chat ?? { title: "", sourceName: "粘贴文本", content: "" });
  const [articleInput, setArticleInput] = useState<ArticleImportInput>(restored.draft?.articleInput ?? { ...emptyArticle });
  const [chatPreview, setChatPreview] = useState<ChatImportPreview>();
  const [dailyDate, setDailyDate] = useState(restored.draft?.dailyDate ?? localDate());
  const [dailyContent, setDailyContent] = useState(restored.draft?.dailyContent ?? "");
  const [dailyPlan, setDailyPlan] = useState<ChangePlan>();
  const [projectPath, setProjectPath] = useState(restored.draft?.projectPath ?? "");
  const [projectContent, setProjectContent] = useState(restored.draft?.projectContent ?? "");
  const [projectPlan, setProjectPlan] = useState<ChangePlan>();
  const [projectStatus, setProjectStatus] = useState("Active");
  const [statusPlan, setStatusPlan] = useState<ChangePlan>();
  const [goal, setGoal] = useState<LearningGoalInput>(restored.draft?.goal ?? emptyGoal);
  const [goalPlan, setGoalPlan] = useState<ChangePlan>();
  const [operations, setOperations] = useState<ChangeResult[]>([]);
  const [restoreId, setRestoreId] = useState<string>();
  const [restorePreview, setRestorePreview] = useState<Awaited<ReturnType<BusinessApi["previewRestore"]>>>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [action, setAction] = useState<"capture" | "chat" | "article" | "pdf" | "daily" | "goal" | "project">();
  const [source, setSource] = useState(false);
  const [showList, setShowList] = useState(false);
  const [projectChoices, setProjectChoices] = useState<NoteSummary[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(restored.warning ?? (restored.draft ? "已恢复当前标签页草稿，尚未写入资料。" : ""));
  const [referenceNotice, setReferenceNotice] = useState("");
  const [storageError, setStorageError] = useState("");
  const listRequest = useRef(0);
  const readRequest = useRef(0);
  const mounted = useRef(true);
  const consumedReference = useRef<NoteReference>();
  const article = useRef<HTMLElement>(null);
  const focusReference = useRef(false);
  const previousPage = useRef(page);

  useEffect(() => {
    if (previousPage.current === page) return;
    previousPage.current = page;
    setAction(undefined);
    setShowList(true);
  }, [page]);

  useEffect(() => {
    if (!loading && focusReference.current) {
      article.current?.focus({ preventScroll: true });
      article.current?.scrollIntoView({ block: "start" });
      focusReference.current = false;
    }
  }, [document, loading]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; listRequest.current++; readRequest.current++; };
  }, []);

  useEffect(() => {
    if (!draftKey) return;
    const edit = editing && document && content !== document.content ? { document, content } : undefined;
    try {
      if (title || captureContent || chat.title || chat.content || articleInput.title || articleInput.url || articleInput.content || dailyContent || projectContent || Object.values(goal).some(Boolean) || edit) sessionStorage.setItem(storageKey(draftKey), JSON.stringify({ title, captureContent, chat, articleInput, dailyDate, dailyContent, projectPath, projectContent, goal, edit } satisfies Draft));
      else sessionStorage.removeItem(storageKey(draftKey));
      setStorageError("");
    } catch (cause) {
      setStorageError(`当前标签页草稿暂存不可用，请勿刷新或关闭；输入仍保留在页面中：${message(cause)}`);
    }
  }, [draftKey, title, captureContent, chat, articleInput, dailyDate, dailyContent, projectPath, projectContent, goal, editing, document, content]);

  async function refresh(search = loadedQuery) {
    const request = ++listRequest.current;
    setLoading(true);
    try {
      const [listed, history] = await Promise.all([api.list(search), api.activity()]);
      if (!mounted.current || request !== listRequest.current) return;
      setNotes(listed);
      if (!search) setProjectChoices(listed.filter(note => note.category === "projects"));
      setOperations(history);
      setLoadedQuery(search);
    } catch (cause) {
      if (mounted.current && request === listRequest.current) setError(message(cause));
    } finally {
      if (mounted.current && request === listRequest.current) setLoading(false);
    }
  }

  useEffect(() => { void refresh(""); }, [api]);

  async function open(path: string, expectedVersion?: string) {
    const request = ++readRequest.current;
    setError("");
    setNextPath(undefined);
    setReading(true);
    try {
      const value = await api.read(path);
      if (!mounted.current || request !== readRequest.current) return;
      focusReference.current = !!expectedVersion;
      setDocument(value);
      setContent(value.content);
      setEditing(false);
      setAction(undefined);
      setShowList(false);
      setPlan(undefined);
      setReferenceNotice(expectedVersion ? value.version === expectedVersion ? "已打开引用的笔记。" : "笔记已在引用后发生变化，当前显示最新原文；请重新核实引用内容。" : "");
    } catch (cause) {
      if (mounted.current && request === readRequest.current) setError(message(cause));
    } finally {
      if (mounted.current && request === readRequest.current) setReading(false);
    }
  }

  function select(path: string, expectedVersion?: string) {
    setShowList(false);
    if (editing && document && content !== document.content) { setNextPath(path); setNextVersion(expectedVersion); }
    else void open(path, expectedVersion);
  }

  useEffect(() => {
    if (!noteReference || consumedReference.current === noteReference || busy) return;
    consumedReference.current = noteReference;
    if (noteReference.scope !== draftKey) { setError("引用属于其他资料目录设置，请在管家中重新检索。"); return; }
    select(noteReference.path, noteReference.version);
  }, [noteReference, busy]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    // A prior read must not replace the document while an operation is in flight.
    readRequest.current++;
    setReading(false);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }

  function requireCompleted(result: ChangeResult) {
    if (result.status !== "completed") throw new Error(result.error || "操作失败，请检查活动记录。");
  }

  const visible = categories[page] ? notes.filter(note => note.category === categories[page]) : notes;
  const projects = projectChoices;
  const actionVisible = ((action === "capture" || action === "chat" || action === "article" || action === "pdf") && page === "Inbox") || ((action === "daily" || action === "goal") && page === "学习") || (action === "project" && page === "项目");
  const dirty = !!(editing && document && content !== document.content);
  return <section className="learning-business" aria-label="资料工作台" data-reader-open={actionVisible || (!!document && !showList)}>
    <div className="learning-business-heading"><div><h2>{page === "概览" ? "全部笔记" : page === "日志" ? "操作记录" : page}</h2><span className="learning-count">{page === "日志" ? operations.length : visible.length}</span></div>
      <div className="learning-actions">
        {page === "Inbox" && <button className="learning-primary" aria-expanded={action === "capture"} aria-controls="learning-capture" onClick={() => setAction(action === "capture" ? undefined : "capture")}><Plus size={15} />新建笔记{(title || captureContent) && <span className="learning-action-draft" title="有草稿" aria-label="有草稿" />}</button>}
        {page === "Inbox" && <button aria-expanded={action === "chat"} aria-controls="learning-chat-import" onClick={() => setAction(action === "chat" ? undefined : "chat")}><Plus size={15} />导入聊天记录{(chat.title || chat.content) && <span className="learning-action-draft" title="有草稿" aria-label="有草稿" />}</button>}
        {page === "Inbox" && <button aria-expanded={action === "pdf"} aria-controls="learning-pdf-import" onClick={() => setAction(action === "pdf" ? undefined : "pdf")}><Plus size={15} />导入 PDF</button>}
        {page === "Inbox" && <button aria-expanded={action === "article"} aria-controls="learning-article-import" onClick={() => setAction(action === "article" ? undefined : "article")}><Plus size={15} />导入网页／Markdown{(articleInput.title || articleInput.url || articleInput.content) && <span className="learning-action-draft" title="有草稿" aria-label="有草稿" />}</button>}
        {page === "学习" && <><button aria-expanded={action === "daily"} aria-controls="learning-daily" onClick={() => setAction(action === "daily" ? undefined : "daily")}><CalendarDays size={15} />记录 Daily{dailyContent && <span className="learning-action-draft" title="有草稿" aria-label="有草稿" />}</button><button className="learning-primary" aria-expanded={action === "goal"} aria-controls="learning-goal" onClick={() => setAction(action === "goal" ? undefined : "goal")}><Plus size={15} />新建目标{Object.values(goal).some(Boolean) && <span className="learning-action-draft" title="有草稿" aria-label="有草稿" />}</button></>}
        {page === "项目" && <button className="learning-primary" aria-expanded={action === "project"} aria-controls="learning-project" onClick={() => setAction(action === "project" ? undefined : "project")}><Plus size={15} />更新项目{projectContent && <span className="learning-action-draft" title="有草稿" aria-label="有草稿" />}</button>}
      </div>
    </div>
    <div className="learning-feedback" aria-live="polite">
    {error && <p role="alert">{error}</p>}
    {storageError && <p role="alert">{storageError}</p>}
    {notice && <p role="status">{notice}</p>}
    </div>
    <div className="learning-note-layout" hidden={page === "日志"}>
    <section className="learning-note-index" aria-label="笔记列表">
    <form className="learning-business-toolbar" onSubmit={event => { event.preventDefault(); setError(""); void refresh(query); }}>
      <div className="learning-search"><Search size={15} /><input aria-label="搜索笔记" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索笔记" /><button className="learning-icon-button" aria-label="搜索" title="搜索" disabled={busy || loading} type="submit"><ArrowLeft size={14} style={{ transform: "rotate(180deg)" }} /></button></div>
      <button className="learning-icon-button" aria-label="刷新" title="刷新" disabled={busy || loading} type="button" onClick={() => { void run(async () => {
        const read = readRequest.current;
        await refresh();
        if (document && !editing && !plan && !actionVisible && read === readRequest.current) await open(document.path);
      }); }}><RefreshCw size={15} className={loading ? "learning-spinning" : undefined} /></button>
    </form>
    {loading && <p role="status">正在读取资料…</p>}
    {loadedQuery && <p className="learning-search-caption">“{loadedQuery}” · {visible.length} 项</p>}
    <ul className="learning-business-list learning-note-list">
      {visible.map(note => <li key={note.path}>
        <button className="learning-note-row" disabled={busy || !!nextPath} onClick={() => select(note.path)} aria-pressed={document?.path === note.path && !actionVisible} aria-label={note.tasks ? `${note.title} · ${note.tasks.total ? `清单 ${note.tasks.completed}/${note.tasks.total}` : "尚无任务清单"}` : note.title}>
          <FileText size={16} /><span><strong>{note.title}</strong><small>{note.path}</small>{note.tasks && <ProgressMeter tasks={note.tasks} compact />}
          {!/^\uFEFF?---(?:\r?\n|$)/.test(note.excerpt) && <span className="learning-note-excerpt">{note.excerpt.replace(/^#+\s*/gm, "").replaceAll("\n", " ")}</span>}
          </span>{note.status && <span className="learning-status" data-status={note.status}>{statusLabels[note.status] ?? note.status}</span>}
        </button>
        {note.metadataError && <p role="alert">属性读取失败：{note.metadataError}</p>}
      </li>)}
    </ul>
    {!loading && !visible.length && <div className="learning-empty"><Search size={24} /><p>{loadedQuery ? "没有匹配的笔记" : "暂无笔记"}</p></div>}
    <footer className="learning-index-footer"><span>{visible.length} 篇笔记</span><span>Markdown</span></footer>
    </section>
    <section className="learning-note-detail" aria-label="笔记与操作">
    <div className="learning-detail-toolbar">
      <button className="learning-mobile-back" disabled={busy} onClick={() => { setNextPath(undefined); setAction(undefined); setShowList(true); }}><ArrowLeft size={15} />笔记列表</button>
      {actionVisible && <button className="learning-icon-button" aria-label="收起表单" title="收起表单" onClick={() => setAction(undefined)}><X size={16} /></button>}
      {dirty && <span className="learning-draft-state">正文有未保存修改</span>}
    </div>
    {nextPath && <div role="alert" className="learning-business-confirm">
      <p>当前笔记有未保存修改，放弃修改并打开 {nextPath}？</p>
      <button disabled={busy} onClick={() => void open(nextPath, nextVersion)}>放弃修改并打开</button>
      <button onClick={() => { setNextPath(undefined); setAction(undefined); }}>继续编辑</button>
    </div>}

    <section id="learning-capture" className="learning-operation" hidden={page !== "Inbox" || action !== "capture"} aria-label="捕获到 Inbox">
      <h3>捕获到 Inbox</h3>
      <form onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const captured = await api.capture(title, captureContent);
          if (!mounted.current) return;
          setTitle(""); setCaptureContent("");
          setNotice(`已保存：${captured.path}`);
          await refresh();
        });
      }}>
        <label>标题<input value={title} disabled={busy} required onChange={event => setTitle(event.target.value)} /></label>
        <label>正文<textarea rows={5} value={captureContent} disabled={busy} required onChange={event => setCaptureContent(event.target.value)} /></label>
        <button disabled={busy || !title.trim() || !captureContent.trim()}>保存到 Inbox</button>
      </form>
    </section>

    <section id="learning-chat-import" className="learning-operation" hidden={page !== "Inbox" || action !== "chat"} aria-label="导入聊天记录">
      <h3>导入聊天记录</h3>
      <p>粘贴聊天原文，或选择一个 UTF-8 文本文件（.txt / .md，最多 2 MB）。预览确认后保存到 Inbox，再交给管家整理。</p>
      <form onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const preview = await api.planChatImport(chat);
          if (mounted.current) setChatPreview(preview);
        });
      }}>
        <label>选择聊天文本文件<input aria-label="选择聊天文本文件" type="file" accept=".txt,.md,text/plain,text/markdown" disabled={busy || !!chatPreview?.plan} onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void run(async () => {
            if (!/\.(txt|md)$/i.test(file.name) || file.size > 2_000_000) throw new Error("请选择不超过 2 MB 的 .txt 或 .md 文件。");
            const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as ArrayBuffer);
              reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
              reader.readAsArrayBuffer(file);
            });
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            if (!text.trim() || text.includes("\x00")) throw new Error("文件没有有效聊天文本，请选择 UTF-8 文本文件。");
            if (!mounted.current) return;
            setChat({ title: chat.title || file.name.replace(/\.(txt|md)$/i, ""), sourceName: file.name, content: text });
            setChatPreview(undefined);
          });
        }} /></label>
        <label>聊天标题<input aria-label="聊天标题" maxLength={200} required value={chat.title} disabled={busy || !!chatPreview?.plan} onChange={event => { setChat({ ...chat, title: event.target.value }); setChatPreview(undefined); }} /></label>
        <label>来源名称<input aria-label="来源名称" maxLength={500} required value={chat.sourceName} disabled={busy || !!chatPreview?.plan} onChange={event => { setChat({ ...chat, sourceName: event.target.value }); setChatPreview(undefined); }} placeholder="例如：DeepSeek · TypeScript 问答" /></label>
        <label>聊天原文<textarea aria-label="聊天原文" rows={10} maxLength={2_000_000} required value={chat.content} disabled={busy || !!chatPreview?.plan} onChange={event => { setChat({ ...chat, content: event.target.value }); setChatPreview(undefined); }} placeholder="保留对话中的角色、时间与内容" /></label>
        <button disabled={busy || !!chatPreview?.plan || !chat.title.trim() || !chat.sourceName.trim() || !chat.content.trim()}>预览聊天导入</button>
      </form>
      {chatPreview?.duplicate && <section className="learning-business-confirm" aria-label="重复聊天记录">
        <p>相同聊天内容已导入：{chatPreview.duplicate.path}。本次不会重复保存。</p>
        <button disabled={busy} onClick={() => select(chatPreview.duplicate!.path)}>查看已导入记录</button>
      </section>}
      {chatPreview?.plan && <section className="learning-business-confirm" aria-label="确认聊天导入">
        <p>将新建 {chatPreview.plan.path}，并保存原文快照。来源：{chatPreview.plan.chat?.sourceName}</p>
        <pre className="learning-business-content">{chatPreview.plan.after}</pre>
        <button disabled={busy} onClick={() => void run(async () => {
          const result = await api.execute(chatPreview.plan!.id);
          requireCompleted(result);
          if (!mounted.current) return;
          setChatPreview(undefined); setChat({ title: "", sourceName: "粘贴文本", content: "" });
          setNotice(`聊天记录已导入：${result.path}。可请管家读取并整理这篇 Inbox 笔记。`);
          await refresh();
          select(result.path);
        })}>确认导入聊天记录</button>
        <button disabled={busy} onClick={() => void run(async () => {
          await api.cancelPlan(chatPreview.plan!.id);
          if (mounted.current) setChatPreview(undefined);
        })}>取消聊天导入</button>
      </section>}
    </section>

    <section id="learning-article-import" className="learning-operation" hidden={page !== "Inbox" || action !== "article"} aria-label="导入网页／Markdown">
      <ArticleImport api={api} input={articleInput} setInput={setArticleInput} busy={busy} run={run} onSelect={select} onImported={async path => {
        if (!mounted.current) return;
        setNotice(`文章已导入：${path}。可请管家读取并整理这篇 Inbox 笔记。`);
        await refresh();
        select(path);
      }} />
    </section>

    <section id="learning-pdf-import" className="learning-operation" hidden={page !== "Inbox" || action !== "pdf"} aria-label="导入 PDF">
      <PdfImport api={api} busy={busy} run={run} onSelect={select} onImported={async path => {
        if (!mounted.current) return;
        setNotice(`PDF 已导入：${path}。可请管家按页读取并整理这篇 Inbox 笔记。`);
        await refresh();
        select(path);
      }} />
    </section>

    <section id="learning-daily" className="learning-operation" hidden={page !== "学习" || action !== "daily"} aria-label="记录 Daily">
      <h3>记录 Daily</h3>
      <form onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const planned = await api.planDailyAppend(dailyDate, dailyContent);
          if (mounted.current) setDailyPlan(planned);
        });
      }}>
        <label>日期<input aria-label="记录日期" type="date" value={dailyDate} disabled={busy || !!dailyPlan} onChange={event => setDailyDate(event.target.value)} required /></label>
        <label>记录内容<textarea aria-label="Daily 记录" rows={6} value={dailyContent} disabled={busy || !!dailyPlan} required onChange={event => setDailyContent(event.target.value)} placeholder="学了什么、做了什么、卡在哪里、下一步是什么？" /></label>
        <button disabled={busy || !!dailyPlan || !dailyDate || !dailyContent.trim()}>预览 Daily 记录</button>
      </form>
      {dailyPlan && <section className="learning-business-confirm" aria-label="确认 Daily 记录">
        <p>确认后将把记录追加到 {dailyPlan.path}，文件不存在时会新建。</p>
        <h4>原文</h4><pre className="learning-business-content">{dailyPlan.before || "（文件尚不存在）"}</pre>
        <h4>新文</h4><pre className="learning-business-content">{dailyPlan.after}</pre>
        <button disabled={busy} onClick={() => void run(async () => {
          const result = await api.execute(dailyPlan.id);
          requireCompleted(result);
          if (!mounted.current) return;
          setDailyPlan(undefined); setDailyContent("");
          setNotice(`Daily 已保存：${result.path}`);
          await refresh();
          select(result.path);
        })}>确认写入 Daily</button>
        <button disabled={busy} onClick={() => setDailyPlan(undefined)}>取消预览</button>
      </section>}
    </section>

    <section id="learning-goal" className="learning-operation" hidden={page !== "学习" || action !== "goal"} aria-label="创建学习目标">
      <h3>创建学习目标</h3>
      <form onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const planned = await api.planLearningGoal(goal);
          if (mounted.current) setGoalPlan(planned);
        });
      }}>
        {(Object.keys(goalLabels) as (keyof LearningGoalInput)[]).map(key => <label key={key}>{goalLabels[key]}
          {["title", "schedule", "targetDate"].includes(key)
            ? <input aria-label={goalLabels[key]} type={key === "targetDate" ? "date" : "text"} value={goal[key]} disabled={busy || !!goalPlan} required={key === "title"} onInput={event => setGoal({ ...goal, [key]: event.currentTarget.value })} />
            : <textarea aria-label={goalLabels[key]} rows={3} value={goal[key]} disabled={busy || !!goalPlan} required={key === "outcome" || key === "verification"} onChange={event => setGoal({ ...goal, [key]: event.target.value })} />}
        </label>)}
        <button disabled={busy || !!goalPlan || !goal.title.trim() || !goal.outcome.trim() || !goal.verification.trim()}>预览学习目标</button>
      </form>
      {goalPlan && <section className="learning-business-confirm" aria-label="确认学习目标">
        <p>{goalPlan.path}</p>
        <pre className="learning-business-content">{goalPlan.after}</pre>
        <button disabled={busy} onClick={() => void run(async () => {
          const result = await api.execute(goalPlan.id);
          requireCompleted(result);
          if (!mounted.current) return;
          setGoalPlan(undefined); setGoal(emptyGoal);
          setNotice(`学习目标已保存：${result.path}`);
          await refresh();
          select(result.path);
        })}>确认创建学习目标</button>
        <button disabled={busy} onClick={() => setGoalPlan(undefined)}>取消目标预览</button>
      </section>}
    </section>

    <section id="learning-project" className="learning-operation" hidden={page !== "项目" || action !== "project"} aria-label="记录项目进展">
      <h3>记录项目进展</h3>
      <form onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const project = projects.find(note => note.path === projectPath);
          if (!project) throw new Error("请选择项目");
          const document = await api.read(project.path);
          const planned = await api.planProjectAppend(document.path, document.version, projectContent);
          if (mounted.current) setProjectPlan(planned);
        });
      }}>
        <label>项目<select aria-label="项目" value={projectPath} disabled={busy || !!projectPlan || !!statusPlan} required onChange={event => setProjectPath(event.target.value)}>
          <option value="">请选择项目</option>
          {projects.map(project => <option key={project.path} value={project.path}>{project.title} · {project.path}</option>)}
        </select></label>
        <label>进展<textarea aria-label="项目进展" rows={5} value={projectContent} disabled={busy || !!projectPlan} required onChange={event => setProjectContent(event.target.value)} placeholder="完成了什么、遇到什么问题、下一步是什么？" /></label>
        <button disabled={busy || !!projectPlan || !!statusPlan || !projectPath || !projectContent.trim()}>预览项目进展</button>
      </form>
      {projectPlan && <section className="learning-business-confirm" aria-label="确认项目进展">
        <p>确认后将更新 {projectPlan.path} 的 Progress 段落，并在写入前保存备份。</p>
        <h4>原文</h4><pre className="learning-business-content">{projectPlan.before}</pre>
        <h4>新文</h4><pre className="learning-business-content">{projectPlan.after}</pre>
        <button disabled={busy} onClick={() => void run(async () => {
          const result = await api.execute(projectPlan.id);
          requireCompleted(result);
          if (!mounted.current) return;
          setProjectPlan(undefined); setProjectContent("");
          setNotice(`项目进展已保存：${result.path}`);
          await refresh();
          select(result.path);
        })}>确认写入项目进展</button>
        <button disabled={busy} onClick={() => setProjectPlan(undefined)}>取消预览</button>
      </section>}
      <form aria-label="切换项目状态" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const current = await api.read(projectPath);
          const planned = await api.planProjectStatus(current.path, current.version, projectStatus);
          if (mounted.current) setStatusPlan(planned);
        });
      }}>
        <p>当前状态：{statusLabels[projects.find(project => project.path === projectPath)?.status ?? ""] ?? projects.find(project => project.path === projectPath)?.status ?? "未设置"}</p>
        <label>新状态<select aria-label="新项目状态" value={projectStatus} disabled={busy || !!statusPlan || !!projectPlan} onChange={event => setProjectStatus(event.target.value)}>
          {Object.entries(statusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
        </select></label>
        <button disabled={busy || !!statusPlan || !!projectPlan || !projectPath}>预览状态修改</button>
      </form>
      {statusPlan && <section className="learning-business-confirm" aria-label="确认项目状态">
        <p>{statusPlan.path}</p>
        <h4>原文</h4><pre className="learning-business-content">{statusPlan.before}</pre>
        <h4>新文</h4><pre className="learning-business-content">{statusPlan.after}</pre>
        <button disabled={busy} onClick={() => void run(async () => {
          const result = await api.execute(statusPlan.id);
          requireCompleted(result);
          if (!mounted.current) return;
          setStatusPlan(undefined);
          setNotice(`项目状态已保存：${result.path}`);
          await refresh();
          select(result.path);
        })}>确认修改项目状态</button>
        <button disabled={busy} onClick={() => setStatusPlan(undefined)}>取消状态预览</button>
      </section>}
    </section>

      {reading && <p className="learning-reading" role="status">正在打开笔记…</p>}
      {document && <article hidden={actionVisible} aria-label="笔记正文" ref={article} tabIndex={-1}>
        <header className="learning-document-header"><div><span className="learning-document-kind"><FileText size={14} />{document.category === "projects" ? "项目" : document.category === "learning" ? "学习目标" : "笔记"}</span><h3>{document.title}</h3><p>{document.path}</p></div></header>
        {document.tasks && <div className="learning-document-progress"><ProgressMeter tasks={document.tasks} />{editing && <small>显示已保存正文的进度</small>}</div>}
        {referenceNotice && <p role="status">{referenceNotice}</p>}
        {!editing ? <>
          <div className="learning-document-tools"><div className="learning-segmented" aria-label="正文视图"><button aria-pressed={!source} onClick={() => setSource(false)}><BookOpen size={14} />阅读</button><button aria-pressed={source} onClick={() => setSource(true)}><Code size={14} />源码</button></div><button disabled={busy || reading} onClick={() => void run(async () => {
            await api.openObsidian(document.path);
            if (mounted.current) setNotice(`已在 Obsidian 打开：${document.path}`);
          })}>在 Obsidian 打开</button><button disabled={busy || reading} onClick={() => { readRequest.current++; setEditing(true); }}><Pencil size={14} />编辑全文</button></div>
          <PdfOriginalLinks key={`${document.path}:${document.version}`} api={api} note={document} busy={busy} run={run} />
          {source ? <pre className="learning-business-content">{document.content}</pre> : <div className="learning-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkFrontmatter]} components={{ a: ({ href, children }) => /^https?:\/\//i.test(href ?? "") ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span className="learning-unresolved-link" title={href}>{children}</span> }}>{document.content}</ReactMarkdown></div>}
        </> : <>
          <label>Markdown 全文<textarea rows={16} value={content} disabled={busy || !!plan || !!nextPath} onChange={event => setContent(event.target.value)} /></label>
          <button disabled={busy || !!plan || !!nextPath || content === document.content} onClick={() => void run(async () => {
            const planned = await api.planUpdate(document.path, document.version, content);
            if (mounted.current) setPlan(planned);
          })}>预览修改</button>
          <button disabled={busy} onClick={() => { setContent(document.content); setEditing(false); setPlan(undefined); setNextPath(undefined); }}>放弃修改</button>
          {plan && <section className="learning-business-confirm" aria-label="确认修改">
            <p>确认后将替换 {plan.path} 的全文，并在写入前保存备份。</p>
            <h4>原文</h4><pre className="learning-business-content">{plan.before}</pre>
            <h4>新文</h4><pre className="learning-business-content">{plan.after}</pre>
            <button disabled={busy || !!nextPath} onClick={() => void run(async () => {
              const result = await api.execute(plan.id);
              requireCompleted(result);
              if (!mounted.current) return;
              setPlan(undefined); setEditing(false);
              setNotice("修改已保存，可在日志中恢复。");
              await open(result.path);
              await refresh();
            })}>确认写入</button>
            <button disabled={busy} onClick={() => setPlan(undefined)}>取消预览，继续编辑</button>
          </section>}
        </>}
      </article>}
      {!document && !actionVisible && !reading && <div className="learning-welcome"><BookOpen size={36} /><h3>从一篇笔记开始</h3><p>{page === "概览" ? "你的知识、项目与学习记录" : page === "知识库" ? "知识库" : page}</p><div className="learning-overview-stats">{[["知识", notes.filter(note => note.category === "knowledge").length], ["项目", projects.length], ["学习", notes.filter(note => note.category === "learning").length]].map(([label, count]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}</div></div>}
    </section>
    </div>

    <section className="learning-activity" hidden={page !== "日志"} aria-label="操作日志">
      {!operations.length && <p>暂无写入记录。</p>}
      <ul className="learning-business-list">
        {operations.map(operation => <li key={operation.id}>
          <p><Clock size={14} />{new Date(operation.at).toLocaleString()} · {{ capture: "捕获", update: "修改", restore: "恢复" }[operation.kind]} · <span className="learning-status" data-status={operation.status === "completed" ? "Active" : "Paused"}>{operation.status === "completed" ? "已完成" : "失败"}</span></p>
          <small>{operation.path}</small>
          {operation.error && <p>{operation.error}</p>}
          {operation.kind === "update" && operation.status === "completed" && <button disabled={busy} onClick={() => void run(async () => { setRestorePreview(undefined); setRestoreId(undefined); const preview = await api.previewRestore(operation.id); if (mounted.current) { setRestorePreview(preview); setRestoreId(operation.id); } })}>恢复修改前版本</button>}
          {restoreId === operation.id && <div className="learning-business-confirm" role="alert">
            <p>确认将 {operation.path} 恢复为此次修改前的内容？文件有后续变化时恢复会被拒绝。</p>
            {restorePreview && <><h4>当前全文</h4><pre className="learning-business-content">{restorePreview.before}</pre><h4>恢复后全文</h4><pre className="learning-business-content">{restorePreview.after}</pre></>}
            <button disabled={busy} onClick={() => void run(async () => {
              const result = await api.restore(operation.id);
              requireCompleted(result);
              if (!mounted.current) return;
              setRestoreId(undefined); setNotice("已恢复修改前版本。");
              // Preserve an open draft; the service will reject its stale version on save.
              if (document?.path === result.path && !editing) await open(result.path);
              await refresh();
            })}>确认恢复</button>
            <button disabled={busy} onClick={() => setRestoreId(undefined)}>取消</button>
          </div>}
        </li>)}
      </ul>
    </section>
  </section>;
}
