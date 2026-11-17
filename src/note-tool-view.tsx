import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { referenceHash, type NoteReference } from "./references";
import { ProgressMeter } from "./progress-meter";
import type { TaskProgress } from "./task-progress";
import type { NoteReuse } from "./knowledge-provenance";

export function NoteToolView({ block, toolName, openReference }: ToolCallViewProps & { openReference: (reference: NoteReference) => void }) {
  const title = toolName === "learning_provenance" ? "知识来源与纠正记录" : toolName === "learning_due_reviews" ? "待复习清单" : toolName === "learning_routines" ? "主动任务状态" : toolName === "learning_review_period" ? "汇总资料来源" : toolName === "learning_search" ? "检索笔记" : toolName === "learning_obsidian_metadata" ? "Obsidian 笔记关系" : "读取笔记";
  if (!("kind" in block)) return <div>{title} · 正在读取…</div>;
  const meta = block.meta as { references?: unknown; tasks?: TaskProgress; reuse?: NoteReuse } | undefined;
  const reuse = meta?.reuse;
  const material = reuse?.kind === "source" ? "来源材料 · 不代表已确认知识"
    : reuse?.kind === "knowledge" ? reuse.savedVersion === "recorded" ? "知识笔记 · 当前版本有保存记录" : "知识笔记 · 当前版本无保存记录"
    : reuse?.kind === "context" ? "背景笔记" : reuse?.kind === "unknown" ? "材料类型待核对" : undefined;
  const tasks = meta?.tasks;
  const validTasks = tasks && Number.isSafeInteger(tasks.total) && Number.isSafeInteger(tasks.completed)
    && tasks.total >= 0 && tasks.completed >= 0 && tasks.completed <= tasks.total;
  const references = Array.isArray(meta?.references) ? meta.references.filter((value): value is NoteReference =>
    value && ["path", "version", "scope"].every(key => typeof value[key] === "string" && value[key].length > 0)) : [];
  return <div className="learning-note-tool">
    <strong>{title}</strong>
    {!block.isError && material && <p>{material}</p>}
    {toolName === "learning_review_period" && <p>日期范围只适用于 Daily；项目和学习笔记是当前快照。</p>}
    {!block.isError && validTasks && <div className="learning-tool-progress"><ProgressMeter tasks={tasks} /><small>读取时的清单快照 · 查看笔记可核对最新内容</small></div>}
    {block.isError ? <p role="alert">{block.error?.reason ?? block.content.filter(item => item.type === "text").map(item => item.text).join("\n")}</p>
      : references.length ? <ul>{references.map((reference, index) => <li key={index}><a href={referenceHash(reference)} onClick={event => { event.preventDefault(); openReference(reference); }}>{reference.path}</a></li>)}</ul>
      : <p>{toolName === "learning_routines" ? "启停与下次触发时间请见学习页的日常管理。" : "没有可用的笔记引用。"}</p>}
    <details><summary>读取结果</summary><pre>{block.content.filter(item => item.type === "text").map(item => item.text).join("\n")}</pre></details>
  </div>;
}
