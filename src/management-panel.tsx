import { useEffect, useRef, useState, type ReactNode } from "react";
import type { businessApi } from "./business-api";
import type { DailyPreview } from "./assistant-daily";
import type { KnowledgeProposal } from "./knowledge-types";
import type { ManagedNote, ManagementResult, ManagementView, PlanSummary } from "./knowledge-management";
import type { NoteReference } from "./references";
import type { SavedBinding } from "./workspace";
import type { NoteProvenance } from "./knowledge-provenance";

const labels = { home: "首页", plans: "全部方案", sources: "来源", knowledge: "知识", projects: "项目", learning: "学习", activity: "记录与恢复", settings: "设置" };
const statuses: Record<KnowledgeProposal["status"], string> = { pending: "待确认", completed: "已保存", cancelled: "已取消", stale: "需重新生成", superseded: "已被新版替代", applying: "保存中", failed: "失败", "needs-reconciliation": "结果待核对", legacy: "旧版方案" };
type Api = ReturnType<typeof businessApi>;

export function ManagementPanel({ api, binding, scope, writable, openReference, settings }: {
  api: Api; binding: SavedBinding; scope: string; writable: boolean; openReference: (reference: NoteReference) => void; settings?: ReactNode;
}) {
  const [view, setView] = useState<ManagementView>("home"), [offset, setOffset] = useState(0), [query, setQuery] = useState("");
  const [result, setResult] = useState<ManagementResult>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ entry: KnowledgeProposal; preview: DailyPreview; actionable: boolean }>();
  const [recovery, setRecovery] = useState<Awaited<ReturnType<Api["previewRestore"]>>>();
  const [trace, setTrace] = useState<NoteProvenance>();
  const generation = useRef(0);
  async function load() {
    const request = ++generation.current;
    const value = await api.management(view, query, offset);
    if (generation.current === request) setResult(value);
  }
  useEffect(() => {
    let active = true;
    setResult(undefined); setSelected(undefined); setRecovery(undefined); setTrace(undefined); setError("");
    void load().catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; generation.current++; };
  }, [view, offset, query, api, writable]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  function navigate(next: ManagementView) { setView(next); setOffset(0); setQuery(""); }
  const review = (entry: KnowledgeProposal, action: "preview" | "confirm" | "cancel") => {
    const identity = { planId: entry.plan.id, ...entry.owner! };
    const method = entry.kind === "daily" ? api.reviewDaily : entry.kind === "project" ? api.reviewProject : entry.kind === "goal" ? api.reviewGoal : entry.kind === "report" ? api.reviewReport : api.reviewInbox;
    return method(identity, action);
  };
  async function inspect(planId: string) {
    setSelected(undefined);
    const entry = (await api.pendingPlans()).find(item => item.plan.id === planId);
    if (!entry) throw new Error("方案不存在，请刷新列表。");
    const owner = entry.owner;
    const own = !owner || (owner.scope === scope && owner.sessionId === binding.sessionId && owner.cwd === binding.cwd);
    const actionable = writable && own;
    const preview = owner && actionable ? await review(entry, "preview") : await api.inspectPlan(planId);
    if (!owner && actionable && preview.status === "pending") await api.previewPlan(planId);
    setSelected({ entry, preview, actionable });
    await load();
  }
  function planCard(plan: PlanSummary) {
    return <li key={plan.planId}><strong>{plan.path}</strong><p>{plan.action} · 修订 {plan.revision} · {statuses[plan.status]} · {plan.origin === "dsh" ? "DSH 方案" : "共享 MCP 方案"}</p>
      {plan.source && <p>来源：{plan.source.path}</p>}{plan.validationError && <p>{plan.validationError}</p>}
      <button disabled={busy} onClick={() => void run(() => inspect(plan.planId))}>查看方案</button>
    </li>;
  }
  function noteCard(note: ManagedNote, pinned = note.pinned ?? false) {
    return <li key={note.path}><strong>{note.title}</strong><p>{note.path}</p>
      {note.reuse.kind === "unknown" && <p>材料类型待核对 · {note.reuse.metadataError}</p>}
      {note.reuse.kind === "knowledge" && <><p>知识笔记 · 当前版本{note.reuse.savedVersion === "recorded" ? "有" : "无"}保存记录；记录不代表事实核验。</p><button disabled={busy} onClick={() => void run(async () => setTrace(await api.provenance(note.path, note.version)))}>查看来源与纠正</button></>}
      {note.reuse.kind === "source" && <><p>来源材料 · {note.sourceStatus}</p><p>最近保存：{note.savedAt ?? "未记录时间"}</p>
        {note.relatedPlans.map(plan => <p key={plan.planId}>{plan.path} · {statuses[plan.status]} <button disabled={busy} onClick={() => void run(() => inspect(plan.planId))}>查看关联方案</button></p>)}</>}
      {note.category === "projects" && <><p>状态：{note.metadataError ? "属性待核对" : note.status ?? "未设置"} · {note.tasks?.total ? `已完成任务 ${note.tasks.completed} / ${note.tasks.total}` : "任务未设置"}</p>
        <details><summary>已保存进展与依据</summary><p>任务数来自当前笔记，不代表项目整体完成度。</p><pre>{note.progressExcerpt ?? "未记录 Progress 进展"}</pre><p>以上为已保存进展末尾节选；完整依据请打开笔记。版本：{note.version}</p></details>
        <button disabled={busy || !writable} onClick={() => void run(async () => { await api.setProjectPinned(note.path, !pinned); await load(); })}>{pinned ? "取消置顶" : "置顶项目"}</button></>}
      <button disabled={busy} onClick={() => openReference({ path: note.path, version: note.version, scope })}>打开笔记</button>
    </li>;
  }
  return <section className="learning-business learning-management" aria-label="知识管家管理">
    <header><h2>{labels[view]}</h2><button disabled={busy} onClick={() => void run(load)}>刷新实际状态</button></header>
    {view === "home" && result?.home && <>
      <section aria-label="待确认方案"><h3>待确认方案 · {result.home.pending.total}</h3><ul className="learning-business-list">{result.home.pending.items.map(planCard)}</ul>{!result.home.pending.total && <p>暂无待确认方案。</p>}<button onClick={() => navigate("plans")}>查看全部方案</button></section>
      <section aria-label="最新来源"><h3>最新来源 · {result.home.sources.total}</h3><ul className="learning-business-list">{result.home.sources.items.map(note => noteCard(note))}</ul>{!result.home.sources.total && <p>暂无已保存来源。</p>}<button onClick={() => navigate("sources")}>查看全部来源</button></section>
      <section aria-label="置顶项目进度"><h3>置顶项目进度 · {result.home.pinned.total}</h3><ul className="learning-business-list">{result.home.pinned.items.map(note => noteCard(note, true))}</ul>{!result.home.pinned.total && <p>未置顶项目，可到项目列表主动选择。</p>}
        {result.home.missingPins.map(path => <p key={path}>置顶笔记已缺失：{path} <button disabled={busy || !writable} onClick={() => void run(async () => { await api.setProjectPinned(path, false); await load(); })}>取消置顶</button></p>)}
        <button onClick={() => navigate("projects")}>查看全部项目</button></section>
    </>}
    <nav aria-label="更多管理入口">{(Object.keys(labels) as ManagementView[]).filter(key => key !== view).map(key => <button key={key} disabled={busy} onClick={() => navigate(key)}>{labels[key]}</button>)}</nav>
    {view !== "home" && view !== "settings" && <label>筛选<input value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setOffset(0); }} /></label>}
    {result?.page && <><p>共 {result.page.total} 项</p><ul className="learning-business-list">{result.page.items.map(item => "planId" in item ? planCard(item) : "version" in item ? noteCard(item) : <li key={item.id}><p>{item.path} · {item.status === "completed" ? "已完成" : "失败"} · {item.at}</p>{item.error && <p>{item.error}</p>}{item.kind === "update" && item.status === "completed" && <button disabled={busy} onClick={() => void run(async () => setRecovery(await api.previewRestore(item.id)))}>预览恢复</button>}</li>)}</ul>
      <button disabled={busy || !offset} onClick={() => setOffset(Math.max(0, offset - 10))}>上一页</button><button disabled={busy || result.page.nextOffset === null} onClick={() => setOffset(result.page!.nextOffset!)}>下一页</button></>}
    {result?.settings && <><h3>共享服务与连接</h3><p>目录映射、项目绑定由可信共享连接配置管理；更改后须重启服务并让两端重连。服务状态／停止使用随包 knowledge status／stop 命令。模型由宿主设置管理。</p><pre>{JSON.stringify(result.settings, null, 2)}</pre>{settings}</>}
    {trace && <section aria-label="知识来源与纠正"><h3>{trace.path} · 保存关系共 {trace.total} 项</h3>{trace.history.map(entry => <div key={entry.planId}><p>{entry.action} · 修订 {entry.revision} · {entry.savedAt} · {entry.matchesCurrent ? "完整输出匹配当前版本" : "历史输出版本"}</p>{entry.source && <><p>来源：{entry.source.path} · {entry.source.state === "unchanged" ? "版本未变" : entry.source.state === "changed" ? "原版本已变化" : "来源已缺失"} · 理由：{entry.source.reason}</p><button disabled={busy || entry.source.state === "missing"} onClick={() => openReference({ path: entry.source!.path, version: entry.source!.version, scope })}>打开来源</button></>}{entry.changes?.map((change, index) => <div key={index}><p>原结论</p><pre>{change.before}</pre><p>采用结论</p><pre>{change.after || "（删除）"}</pre></div>)}</div>)}
      <p>历史输出不同不代表全部结论被废弃；来源关系不代替原文读取。</p>{trace.nextOffset !== null && <button disabled={busy} onClick={() => void run(async () => setTrace(await api.provenance(trace.path, trace.version, trace.nextOffset!)))}>下一条保存关系</button>}<button onClick={() => setTrace(undefined)}>关闭追溯</button></section>}
    {selected && <section className="learning-business-confirm" aria-label="集中方案预览"><h3>{selected.preview.plan.path} · 修订 {selected.preview.revision ?? selected.entry.revision}</h3><p role="status">{statuses[selected.preview.status]}</p>
      <p>方案：{selected.entry.plan.id}；需要纠正时在原聊天说明要求并生成新版。</p>
      {selected.preview.plan.inbox && <p>来源：{selected.preview.plan.inbox.path} · 版本 {selected.preview.plan.inbox.version} · 理由：{selected.preview.plan.inbox.reason}</p>}
      {selected.preview.validationError && <p role="alert">{selected.preview.validationError}</p>}
      <h4>修改前全文</h4><pre>{selected.preview.plan.before || "（新建，无原文）"}</pre><h4>保存后全文</h4><pre>{selected.preview.plan.after}</pre>
      {!writable ? <p>当前为只读连接，不能确认或取消方案。</p> : !selected.actionable && <p>请切回原 DSH 管家会话查看、确认或取消此方案。原会话：{selected.entry.owner?.sessionId}</p>}
      {selected.actionable && selected.preview.status === "pending" && (["confirm", "cancel"] as const).map(action => <button key={action} disabled={busy} onClick={() => void run(async () => {
        if (selected.entry.owner) await review(selected.entry, action);
        else if (action === "confirm") await api.execute(selected.entry.plan.id); else await api.cancelPlan(selected.entry.plan.id);
        await inspect(selected.entry.plan.id);
      })}>{action === "confirm" ? "确认保存此方案" : "取消此方案"}</button>)}
      <button disabled={busy} onClick={() => setSelected(undefined)}>关闭预览</button>
    </section>}
    {recovery && <section className="learning-business-confirm" aria-label="恢复预览"><h3>恢复：{recovery.path}</h3><p>当前版本：{recovery.version}；后续编辑会使本次恢复失效。</p><h4>当前全文</h4><pre>{recovery.before}</pre><h4>恢复后全文</h4><pre>{recovery.after}</pre>
      <button disabled={busy || !writable} onClick={() => void run(async () => { const value = await api.restore(recovery.operationId); if (value.status !== "completed") throw new Error(value.error ?? "恢复失败"); setRecovery(undefined); await load(); })}>确认恢复此版本</button><button disabled={busy} onClick={() => setRecovery(undefined)}>取消恢复</button></section>}
    {!result && !error && <p role="status">正在读取共享状态…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
