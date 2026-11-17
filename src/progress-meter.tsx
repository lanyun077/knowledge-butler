import type { TaskProgress } from "./task-progress";

export function ProgressMeter({ tasks, compact = false }: { tasks?: TaskProgress; compact?: boolean }) {
  if (!tasks?.total) return <span className="learning-progress-empty">尚无任务清单{!compact && <small>可在正文中添加任务，完成后勾选。</small>}</span>;
  const ratio = tasks.completed / tasks.total * 100;
  const percent = tasks.completed === tasks.total ? 100 : Math.min(99, Math.round(ratio));
  return <span className="learning-progress" data-compact={compact}>
    <span className="learning-progress-label"><span>{compact ? "清单" : tasks.completed === tasks.total ? "清单已完成" : "清单完成"} {tasks.completed}/{tasks.total}</span>{!compact && <strong>{percent}%</strong>}</span>
    <span className="learning-progress-track" role={compact ? undefined : "progressbar"} aria-hidden={compact || undefined}
      aria-label={compact ? undefined : "清单完成"} aria-valuemin={compact ? undefined : 0}
      aria-valuemax={compact ? undefined : tasks.total} aria-valuenow={compact ? undefined : tasks.completed}
      aria-valuetext={compact ? undefined : `${tasks.total} 项任务已完成 ${tasks.completed} 项`}>
      <span style={{ width: `${ratio}%` }} />
    </span>
    {!compact && <small>按本文任务复选框统计</small>}
  </span>;
}
