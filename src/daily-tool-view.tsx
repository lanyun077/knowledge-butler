import { useEffect, useState } from "react";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import { businessApi, vaultScope, type PlainConfig } from "./business-api";
import type { DailyProposal, DailyPreview } from "./assistant-daily";
import type { NoteReference } from "./references";

export function dailyFace(form: ConfigForm<PlainConfig>, rpc: ClientConnectionRpc, openReference: (reference: NoteReference) => void) {
  return { hooks: { configuration: form }, rpc, openReference };
}

export function DailyToolView({ block, toolName, useConfiguration, rpc, openReference }: ToolCallViewProps & InjectFace<ReturnType<typeof dailyFace>>) {
  const configuration = useConfiguration(value => value);
  const value = configuration.value;
  const createGoal = toolName === "learning_plan_goal";
  const goalSteps = toolName === "learning_plan_goal_steps";
  const goalTask = toolName === "learning_plan_goal_task";
  const goalRecall = toolName === "learning_plan_goal_recall";
  const goalReviewDate = toolName === "learning_plan_goal_review_date";
  const goal = createGoal || goalSteps || goalTask || goalRecall || goalReviewDate || toolName === "learning_plan_goal_evidence";
  const projectStatus = toolName === "learning_plan_project_status";
  const project = projectStatus || toolName === "learning_plan_project_progress";
  const correction = toolName === "learning_plan_correction" || toolName === "learning_revise_correction";
  const inbox = toolName === "learning_plan_inbox" || correction;
  const report = toolName === "learning_plan_review";
  const meta = "kind" in block ? block.meta as { dailyProposal?: DailyProposal; projectProposal?: DailyProposal; goalProposal?: DailyProposal; inboxProposal?: DailyProposal; reportProposal?: DailyProposal } | undefined : undefined;
  const proposal = report ? meta?.reportProposal : inbox ? meta?.inboxProposal : goal ? meta?.goalProposal : project ? meta?.projectProposal : meta?.dailyProposal;
  const api = value?.vault ? businessApi(rpc, value.vault) : undefined;
  const reviewProposal = report ? api?.reviewReport : inbox ? api?.reviewInbox : goal ? api?.reviewGoal : project ? api?.reviewProject : api?.reviewDaily;
  const [preview, setPreview] = useState<DailyPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = !!proposal && ["planId", "scope", "sessionId", "cwd"].every(key => typeof proposal[key as keyof DailyProposal] === "string")
    && configuration.status === "ready" && configuration.writable && configuration.mode === "host"
    && !!value?.vault && vaultScope(value.vault) === proposal.scope && value.binding.sessionId === proposal.sessionId && value.binding.cwd === proposal.cwd;
  useEffect(() => {
    let active = true;
    setPreview(undefined); setError("");
    if (valid) {
      void reviewProposal!(proposal!, "preview")
        .then(result => { if (active) setPreview(result); })
        .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    }
    return () => { active = false; };
  }, [valid, project, goal, inbox, report, proposal?.planId, proposal?.scope, proposal?.sessionId, proposal?.cwd, rpc]);
  async function review(action: "cancel" | "confirm") {
    if (!valid || busy || preview?.status !== "pending") return;
    setBusy(true); setError("");
    try { setPreview(await reviewProposal!(proposal!, action)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function openNote(source?: { path: string; version: string }) {
    if (!valid || !preview) return;
    setBusy(true); setError("");
    try {
      const document = await businessApi(rpc, value!.vault).read(source?.path ?? preview.plan.path);
      openReference({ path: document.path, version: source?.version ?? document.version, scope: proposal!.scope });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const labels = { pending: "待确认 · 尚未写入", cancelled: "已取消 · 未写入", completed: "已保存", failed: "保存失败 · 请重新生成方案",
    stale: "来源或目标已变化 · 请重新生成方案", superseded: "已被新版替代 · 不能保存旧版", applying: "正在保存 · 请稍候",
    "needs-reconciliation": "结果待核对 · 请检查记录和原文", legacy: "旧版方案 · 请重新生成" };
  return <div className="learning-daily-tool" data-proposal-kind={report ? "report" : inbox ? "inbox" : goal ? "goal" : project ? "project" : "daily"}>
    <strong>{report ? "保存进展汇总" : correction ? "纠正已有知识" : inbox ? "整理一条 Inbox" : createGoal ? "创建学习目标" : goalSteps ? "追加学习行动计划" : goalTask ? "更新学习任务勾选" : goalRecall ? "保存手动复习记录" : goalReviewDate ? "设置下次复习日期" : goal ? "记录学习证据" : projectStatus ? "更新项目状态" : project ? "更新项目进展" : "记录学习"}</strong>
    {!("kind" in block) ? <p>正在生成方案…</p> : block.isError ? <p role="alert">{block.content.filter(item => item.type === "text").map(item => item.text).join("\n")}</p>
      : !valid ? <p role="alert">资料目录或管家会话已变化，无法确认此方案。</p>
      : preview ? <>
        <p className="learning-daily-path">{preview.plan.path}</p>
        <p role="status">{labels[preview.status]}</p>
        {preview.validationError && <p role="alert">{preview.validationError}</p>}
        {createGoal && <p>时间安排仅保存你的描述，不会自动排课或提醒。</p>}
        {goalRecall && <p>请核对日期、问题和你的实际回答；复习记录不代表成果已验证，也不会自动勾选任务或排期。</p>}
        {goalReviewDate && <p>仅设置或清除下次复习日期；主动提醒需要单独开启。</p>}
        {projectStatus && <p>仅更新项目状态，不修改任务勾选，也不移动笔记。</p>}
        {report && preview.plan.report && <>
          <p>{preview.plan.report.startDate} 至 {preview.plan.report.endDate}（含首尾，仅适用于 Daily）</p>
          <p>选用 {preview.plan.report.sources.length} / {preview.plan.report.total} 篇候选资料；项目和学习资料是当前无日期快照。</p>
          <p>收集时缺少 Daily：{preview.plan.report.missingDailyDates.join("、") || "无"}；排除无日期或无效日期 Daily：{preview.plan.report.excludedDailyNotes} 篇。缺少记录不代表没有学习。</p>
          <details><summary>查看汇总来源</summary>{preview.plan.report.sources.map(source => <div key={source.path}>
            <p className="learning-daily-path">{source.path} · {source.date ?? "当前无日期快照"}</p>
            <button disabled={busy} onClick={() => { void openNote(source); }}>查看来源：{source.path}</button>
          </div>)}</details>
        </>}
        {inbox && preview.plan.inbox && <>
          <p>整理方式：{preview.plan.correction ? "替换已列出的旧结论，其他内容和属性保留" : preview.plan.create ? "新建知识笔记" : "追加到已有知识笔记"}，原始 Inbox 保留。</p>
          <p>修订：{preview.revision ?? 1}</p>
          <p>推荐理由：{preview.plan.inbox.reason}</p>
          <p className="learning-daily-path">来源：{preview.plan.inbox.path}</p>
          <button disabled={busy} onClick={() => { void openNote(preview.plan.inbox); }}>查看 Inbox 原文</button>
        </>}
        {preview.plan.correction && <details open><summary>本次替换内容</summary>
          {preview.plan.correction.changes.map((change, index) => <div key={index}>
            <p>替换 {index + 1} · 原结论</p><pre>{change.before}</pre>
            <p>采用结论</p><pre>{change.after || "（删除）"}</pre>
          </div>)}
        </details>}
        {preview.status === "pending" && <>
          <details><summary>{preview.plan.create ? "将新建笔记（没有原文）" : "查看修改前原文"}</summary><pre>{preview.plan.before || "（空）"}</pre></details>
          <details open><summary>保存后的完整内容</summary><pre>{preview.plan.after}</pre></details>
          <div className="learning-daily-actions"><button disabled={busy} onClick={() => { void review("confirm"); }}>{busy ? "正在处理…" : "确认保存"}</button><button disabled={busy} onClick={() => { void review("cancel"); }}>取消方案</button></div>
        </>}
        {preview.status === "completed" && <button disabled={busy} onClick={() => { void openNote(); }}>查看已保存笔记</button>}
        {preview.result?.error && <p role="alert">{preview.result.error}</p>}
      </> : !error && <p>正在读取方案…</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
