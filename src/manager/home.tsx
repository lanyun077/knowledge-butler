import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronRight, GraduationCap, GripVertical, History, Inbox, Minus, Pin, Plus, X } from "lucide-react";
import type { ManagerSnapshot } from "../knowledge-manager-contract";

export const modules = {
  pending: { title: "待保存", description: "需要你过目的整理与归纳", icon: Inbox, view: "plans" },
  projects: { title: "置顶项目", description: "回到正在推进的重要项目", icon: Pin, view: "projects" },
  records: { title: "最近记录", description: "查看保存的内容、位置与出处", icon: History, view: "records" },
  knowledge: { title: "最近知识", description: "整理与更新过的知识笔记", icon: BookOpen, view: "knowledge" },
  learning: { title: "学习目标", description: "保持关注的目标与行动", icon: GraduationCap, view: "learning" },
} as const;
export type ModuleId = keyof typeof modules;
export interface Preferences { order: ModuleId[]; limits: Partial<Record<ModuleId, number>>; theme?: "light" | "dark" }
export const defaultPreferences: Preferences = { order: ["pending", "projects", "records"], limits: {} };
const key = (libraryId: string) => `knowledge-manager:${libraryId}:appearance`;
export function loadPreferences(libraryId: string): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key(libraryId)) ?? "null");
    if (!saved || !Array.isArray(saved.order)) return defaultPreferences;
    return { order: [...new Set<ModuleId>(saved.order.filter((id: unknown): id is ModuleId => typeof id === "string" && Object.hasOwn(modules, id)))],
      limits: Object.fromEntries(Object.keys(modules).filter(id => [2, 3, 5].includes(saved.limits?.[id])).map(id => [id, saved.limits[id]])),
      theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : undefined };
  } catch { return defaultPreferences; }
}
export function savePreferences(libraryId: string, preferences: Preferences) {
  try { localStorage.setItem(key(libraryId), JSON.stringify(preferences)); return true; } catch { return false; }
}
type Home = NonNullable<NonNullable<ManagerSnapshot["management"]>["home"]>;
type Row = NonNullable<NonNullable<ManagerSnapshot["management"]>["page"]>["items"][number];

export function HomeModules({ home, preferences, disabled, renderRows, navigate }: {
  home: Home; preferences: Preferences; disabled: boolean; renderRows: (items: Row[], compact?: boolean) => ReactNode;
  navigate: (view: typeof modules[ModuleId]["view"]) => void;
}) {
  return <div className="module-grid">{preferences.order.map(id => {
    const module = modules[id], page = home[id === "projects" ? "pinned" : id], Icon = module.icon;
    return <section className="module" data-module={id} key={id} aria-label={module.title}>
      <div className="module-head"><div className="module-title"><Icon aria-hidden="true" /><h2>{module.title}</h2><span className="count">{page.total}</span></div>
        <button className="text-button" disabled={disabled} onClick={() => navigate(module.view)} aria-label={`查看全部${module.title}`}>查看全部<ChevronRight aria-hidden="true" /></button></div>
      {renderRows(page.items.slice(0, preferences.limits[id] ?? 2), true)}
    </section>;
  })}</div>;
}

export function ModuleManager({ preferences, update, close, storageNotice }: { preferences: Preferences; update: (value: Preferences) => void; close: () => void; storageNotice: string }) {
  const dialog = useRef<HTMLDialogElement>(null), list = useRef<HTMLDivElement>(null);
  const dragged = useRef<ModuleId>(), target = useRef<ModuleId>();
  const [dragging, setDragging] = useState<ModuleId>(), [over, setOver] = useState<ModuleId>();
  const [announcement, announce] = useState("");
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  function move(id: ModuleId, to: number) {
    const order = preferences.order.filter(item => item !== id); order.splice(to, 0, id);
    update({ ...preferences, order }); announce(`${modules[id].title}已移至第 ${to + 1} 位`);
  }
  function end() {
    if (dragged.current && target.current) move(dragged.current, preferences.order.indexOf(target.current));
    dragged.current = undefined; target.current = undefined; setDragging(undefined); setOver(undefined);
  }
  return <dialog ref={dialog} className="module-dialog" aria-labelledby="module-dialog-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-head"><h2 id="module-dialog-title">管理模块</h2><button className="icon-button" aria-label="关闭管理模块" onClick={close}><X aria-hidden="true" /></button></div>
    <p className="muted">选择首页内容，拖动手柄调整优先级。</p>
    <p className="sr-only" role="status">{announcement}</p>
    <div className="module-options" ref={list}>
      {[...preferences.order, ...(Object.keys(modules) as ModuleId[]).filter(id => !preferences.order.includes(id))].map(id => {
        const module = modules[id], Icon = module.icon, enabled = preferences.order.includes(id);
        return <div className="module-option" data-module={id} data-sort-id={enabled ? id : undefined} data-dragging={dragging === id} data-drag-over={over === id} key={id}>
          {enabled ? <button className="icon-button drag-handle" aria-label={`拖动排序${module.title}`} title="拖动排序，也可使用上下方向键"
            onKeyDown={event => { if (!["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); const to = preferences.order.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1); if (to >= 0 && to < preferences.order.length) move(id, to); }}
            onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragged.current = id; setDragging(id); }}
            onPointerMove={event => {
              if (!dragged.current) return;
              const next = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-sort-id]")?.dataset.sortId as ModuleId | undefined;
              target.current = next; setOver(next);
              const bounds = list.current!.getBoundingClientRect();
              if (event.clientY < bounds.top + 35) list.current!.scrollTop -= 16;
              if (event.clientY > bounds.bottom - 35) list.current!.scrollTop += 16;
            }} onPointerUp={end} onPointerCancel={() => { dragged.current = undefined; target.current = undefined; setDragging(undefined); setOver(undefined); }}><GripVertical aria-hidden="true" /></button> : <span className="option-icon"><Icon aria-hidden="true" /></span>}
          <div className="option-description"><h3>{module.title}</h3><p>{module.description}</p></div>
          {enabled && <select aria-label={`${module.title}展示条数`} value={preferences.limits[id] ?? 2} onChange={event => update({ ...preferences, limits: { ...preferences.limits, [id]: Number(event.target.value) } })}>{[2, 3, 5].map(count => <option key={count} value={count}>{count} 条</option>)}</select>}
          <button className="icon-button" aria-label={`${enabled ? "移除" : "添加"}${module.title}`} onClick={() => { update({ ...preferences, order: enabled ? preferences.order.filter(item => item !== id) : [...preferences.order, id] }); announce(`${module.title}已${enabled ? "移除" : "添加"}`); }}>{enabled ? <Minus aria-hidden="true" /> : <Plus aria-hidden="true" />}</button>
        </div>;
      })}
    </div>
    <div className="dialog-foot"><span className="muted"><Check aria-hidden="true" />{storageNotice || "布局保存在当前设备"}</span><button className="primary" onClick={close}>完成</button></div>
  </dialog>;
}
