import { useEffect, useState } from "react";
import type { businessApi, PlainConfig } from "./business-api";
import type { ChangePlan, NoteSummary } from "./vault";
import type { DueReviews } from "./due-reviews";
import type { RoutineKind, RoutineStatus } from "./routines";
import type { NoteReference } from "./references";

const labels: Record<RoutineKind, string> = { "review-reminder": "每24小时复习提醒", "weekly-report": "每7天周报" };
export type DailyManagementApi = Pick<ReturnType<typeof businessApi>, "list" | "read" | "dueReviews" | "planGoalReviewDate" | "execute" | "routines" | "setRoutine" | "stopRoutine">;
function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function DailyManagement({ api, binding, scope, openReference }: {
  api: DailyManagementApi; binding: PlainConfig["binding"]; scope: string; openReference: (reference: NoteReference) => void;
}) {
  const [date, setDate] = useState(localDate);
  const [due, setDue] = useState<DueReviews>();
  const [goals, setGoals] = useState<NoteSummary[]>([]);
  const [path, setPath] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [plan, setPlan] = useState<ChangePlan>();
  const [routines, setRoutines] = useState<RoutineStatus>();
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    void Promise.allSettled([api.dueReviews(date), api.list(), ...(binding.sessionId ? [api.routines(binding)] : [])]).then(results => {
      if (!active) return;
      if (results[0].status === "fulfilled") setDue(results[0].value as DueReviews);
      if (results[1].status === "fulfilled") setGoals((results[1].value as NoteSummary[]).filter(note => note.category === "learning"));
      if (results[2]?.status === "fulfilled") setRoutines(results[2].value as RoutineStatus);
      setError(results.filter(result => result.status === "rejected").map(result => String(result.reason)).join("\n"));
      setBusy(false);
    });
    return () => { active = false; };
  }, [api, binding.sessionId, binding.cwd]);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <details className="learning-operation learning-business learning-daily-management">
    <summary>日常管理 · 复习与主动任务</summary>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <section aria-label="待复习清单">
      <h3>待复习清单</h3>
      <form onSubmit={event => { event.preventDefault(); void run(async () => setDue(await api.dueReviews(date))); }}>
        <label>截止日期<input type="date" required value={date} disabled={busy} onChange={event => setDate(event.target.value)} /></label>
        <button disabled={busy}>查询待复习</button>
      </form>
      {due && <>
        <p>截至 {due.date} 到期 {due.total} 个；另有 {due.unscheduled} 个未设置日期。暂停、完成、归档目标不列入。</p>
        {!due.total && <p>当前没有到期目标。</p>}
        <ul>{due.sources.map(note => <li key={note.path}>
          <button disabled={busy} onClick={() => openReference({ path: note.path, version: note.version, scope })}>{note.title}</button>
          <span> · {note.date} · {note.overdue ? "已逾期" : "当天到期"}</span>
        </li>)}</ul>
        {due.truncated && <button disabled={busy} onClick={() => void run(async () => {
          const next = await api.dueReviews(due.date, due.nextOffset);
          setDue({ ...next, sources: [...due.sources, ...next.sources] });
        })}>加载更多待复习</button>}
        {due.invalid.map(item => <p role="alert" key={item.path}>{item.path}：{item.error}</p>)}
      </>}
    </section>
    <section aria-label="设置复习日期">
      <h3>设置下次复习日期</h3>
      <p>只记录你选定的日期；清空表示暂不安排。保存复习问答不会自动推迟日期。</p>
      <form onSubmit={event => { event.preventDefault(); void run(async () => {
        const note = await api.read(path);
        setPlan(await api.planGoalReviewDate(note.path, note.version, nextDate || null));
      }); }}>
        <label>学习目标<select required value={path} disabled={busy || !!plan} onChange={event => setPath(event.target.value)}>
          <option value="">请选择学习笔记（须为学习目标）</option>
          {goals.map(goal => <option value={goal.path} key={goal.path}>{goal.title} · {goal.path}</option>)}
        </select></label>
        <label>下次复习日期<input type="date" value={nextDate} disabled={busy || !!plan} onChange={event => setNextDate(event.target.value)} /></label>
        <button disabled={busy || !!plan || !path}>{nextDate ? "预览复习日期" : "预览清除复习日期"}</button>
      </form>
      {plan && <div className="learning-business-confirm">
        <p>{plan.path}</p><details><summary>修改前原文</summary><pre className="learning-business-content">{plan.before}</pre></details>
        <details open><summary>保存后的完整内容</summary><pre className="learning-business-content">{plan.after}</pre></details>
        <button disabled={busy} onClick={() => void run(async () => {
          const result = await api.execute(plan.id);
          if (result.status !== "completed") throw new Error(result.error || "复习日期保存失败。");
          setPlan(undefined); setNotice("复习日期已保存。"); setDue(await api.dueReviews(date));
        })}>确认保存复习日期</button>
        <button disabled={busy} onClick={() => setPlan(undefined)}>取消复习日期方案</button>
      </div>}
    </section>
    <section aria-label="主动提醒与周报">
      <h3>主动提醒与周报</h3>
      <p>分别开启，默认关闭。从开启时刻起每24小时或7天触发；暂停会停止该任务，重新开启从新时刻计时。</p>
      <p>任务属于当前会话，切换不会迁移；请切回原会话查看或暂停。需要原会话保持连接并被选中、模型可用；关闭宿主后不能准时提醒，重开会处理最近一次逾期任务。提醒出现在原对话中。周报整理此前7个完整日期，保存笔记仍需确认。</p>
      <label>日期解释时区<input aria-label="任务时区" value={timeZone} disabled={busy} onChange={event => setTimeZone(event.target.value)} /></label>
      <p>启用时保存此时区；修改已启用任务的时区，请先暂停再开启。</p>
      {!binding.sessionId ? <p>请先连接管家会话。</p> : !routines ? <p>正在读取任务状态…</p> : !routines.available ? <p role="status">{routines.reason}</p> : <>
        {(Object.keys(labels) as RoutineKind[]).map(kind => {
          const enabled = routines.items.filter(item => item.kind === kind && item.currentScope);
          return <div key={kind}>
            <p>{labels[kind]} · {enabled.length ? "已开启" : "已暂停"}</p>
            {enabled.map(item => <p key={item.id}>下次：{new Date(item.scheduledAt).toLocaleString()} · {item.state === "overdue" ? "已逾期，等待会话空闲" : "等待触发"} · 日期时区 {item.timeZone}</p>)}
            <button disabled={busy || (!enabled.length && !timeZone.trim())} onClick={() => void run(async () => {
              setRoutines(await api.setRoutine(binding, kind, !enabled.length, timeZone.trim()));
              setNotice(enabled.length ? `${labels[kind]}已暂停。` : `${labels[kind]}已开启。`);
            })}>{enabled.length ? `暂停${labels[kind]}` : `开启${labels[kind]}`}</button>
          </div>;
        })}
        {routines.items.filter(item => !item.currentScope).map(item => <div key={item.id}>
          <p>{labels[item.kind]}属于旧资料映射，不会用于当前资料，请暂停。</p>
          <button disabled={busy} onClick={() => void run(async () => setRoutines(await api.stopRoutine(binding, item.id)))}>暂停旧任务</button>
        </div>)}
      </>}
      <button disabled={busy || !binding.sessionId} onClick={() => void run(async () => setRoutines(await api.routines(binding)))}>刷新主动任务状态</button>
    </section>
  </details>;
}
