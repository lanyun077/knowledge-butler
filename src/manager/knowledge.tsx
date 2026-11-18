import type { App } from "@modelcontextprotocol/ext-apps";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Maximize2, Search } from "lucide-react";
import type { ManagerSnapshot } from "../knowledge-manager-contract";
import { drawMindmap, type Chart, type Selection, type TopicChart } from "./charts";
import { StarMap } from "./star-map";
import { Disclosure } from "./disclosure";
import { openManagerNote } from "./open-note";

type Topic = NonNullable<ManagerSnapshot["topic"]>;
export function KnowledgeWorkspace({ topic, theme, app, disabled, offset, onPage, organize }: {
  topic: Topic; theme: string; app: App; disabled: boolean; offset: number; onPage(offset: number): void; organize(): void;
}) {
  const [view, setView] = useState<"graph" | "mindmap" | "document">("graph"), [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Selection>(), [notice, setNotice] = useState("");
  const container = useRef<HTMLDivElement>(null), chart = useRef<Chart>();
  const model = useMemo<TopicChart>(() => topic.organized ? { title: topic.title,
    items: [...topic.organized.items.items, ...topic.organized.endpoints], relations: topic.organized.relations.items }
    : { title: topic.title, items: topic.notes.map(note => ({ id: note.path, title: note.title, group: "关联笔记", summary: note.summary, evidence: "" })),
      relations: topic.links.filter(link => link.state === "resolved" && link.targetPath && topic.notes.some(note => note.path === link.sourcePath) && topic.notes.some(note => note.path === link.targetPath))
        .map(link => ({ from: link.sourcePath, to: link.targetPath!, type: "引用", inferred: false, evidence: "笔记中的显式链接" })) }, [topic]);
  useEffect(() => { setSelection(undefined); setSearch(""); setNotice(""); }, [topic]);
  useEffect(() => {
    if (view !== "mindmap" || !container.current || !model.items.length) return;
    try { chart.current = drawMindmap(container.current, model, setSelection); }
    catch { setNotice("图形暂不可用，可以使用下方条目列表。"); }
    return () => { chart.current?.destroy(); chart.current = undefined; };
  }, [view, model, theme]);
  async function open() {
    try {
      await openManagerNote(app, topic.path);
      setNotice("已请求在 Obsidian 打开。");
    } catch { setNotice("宿主无法打开此链接，请复制下方路径在 Obsidian 查找。"); }
  }
  const item = selection?.kind === "item" ? model.items.find(item => item.id === selection.id) : undefined;
  const relation = selection?.kind === "relation" ? model.relations[selection.index] : undefined;
  const filtered = model.items.filter(item => `${item.title} ${item.group} ${item.summary}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="surface knowledge-workspace" aria-label="知识视图" data-category="knowledge">
    <div className="knowledge-intro"><p className="excerpt">{topic.summary}</p><div className="row-actions"><button onClick={() => void open()}>在 Obsidian 打开<ArrowUpRight aria-hidden="true" /></button><button disabled={disabled} onClick={organize}>更新整理</button></div></div>
    <div className="knowledge-toolbar"><div className="view-tabs" role="group" aria-label="知识展示方式">
      {([['graph', '三维星图'], ['mindmap', '思维导图'], ['document', 'Markdown']] as const).map(([id, label]) => <button key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
    </div>{view === "mindmap" && <button className="icon-button" aria-label="适应画布" onClick={() => chart.current?.fit()}><Maximize2 aria-hidden="true" /></button>}</div>
    {view !== "graph" && <p className="meta">{topic.organized ? `${topic.organized.items.total} 个知识条目 · ${topic.organized.relations.total} 条关系` : "普通笔记 · 显式笔记链接"}{` · 当前批次 ${model.items.length} 个节点`}</p>}
    {view === "graph" && <StarMap app={app} theme={theme} focusPath={topic.path} />}
    {view === "mindmap" && model.items.length > 0 && <><div className="knowledge-chart" ref={container} role="img" aria-label="知识分组导图，下方有条目列表" /><p className="meta">分组导图仅展示整理层级；交叉关系和依据可从下方关系列表查看。</p></>}
    {view === "document" && <p className="excerpt">完整正文请在 Obsidian 阅读。</p>}
    {notice && <p role="status" className="feedback">{notice}</p>}
    {topic.organized?.invalidRelations ? <p className="meta">有 {topic.organized.invalidRelations} 条关系的端点已失效，未绘制；可在 Markdown 中修正。</p> : null}
    {view !== "graph" && (item || relation) && <aside className="knowledge-selection" aria-label="所选内容"><h2>{item?.title ?? `${model.items.find(item => item.id === relation!.from)?.title} · ${relation!.type} · ${model.items.find(item => item.id === relation!.to)?.title}`}</h2>
      {item ? <><p className="meta">{item.group}</p><p className="excerpt">{item.summary}</p><p className="excerpt">{item.evidence || "出处请在 Markdown 中查看。"}</p></> : <><p className="meta">{relation!.type} · {relation!.inferred ? "推断" : "显式"}</p><p className="excerpt">{relation!.evidence}</p></>}
      <button className="text-button" onClick={() => setSelection(undefined)}>收起详情</button></aside>}
    {view !== "graph" && <>
    <label className="filter"><Search aria-hidden="true" /><span className="sr-only">筛选当前批次条目</span><input placeholder="筛选当前批次条目" value={search} onChange={event => setSearch(event.target.value)} /></label>
    {filtered.length ? <ul className="knowledge-items">{filtered.map(item => <li key={item.id}><button aria-pressed={selection?.kind === "item" && selection.id === item.id} onClick={() => setSelection(selection?.kind === "item" && selection.id === item.id ? undefined : { kind: "item", id: item.id })}><span>{item.title}</span><span className="meta">{item.group}</span></button>{view === "document" && <p className="excerpt">{item.summary}</p>}</li>)}</ul> : <p className="muted">{search ? "当前批次没有匹配条目。" : "暂无可展示条目，可更新整理或直接打开 Markdown。"}</p>}
    {!!model.relations.length && <Disclosure className="knowledge-relations" title={`关系 · ${model.relations.length} 条`}><ul>{model.relations.map((relation, index) => <li key={index}><button onClick={() => setSelection({ kind: "relation", index })}>{model.items.find(item => item.id === relation.from)?.title} · {relation.type} · {model.items.find(item => item.id === relation.to)?.title}{relation.inferred ? "（推断）" : ""}</button></li>)}</ul></Disclosure>}
    {(offset > 0 || topic.nextOffset !== null) && <div className="pager" aria-label="知识批次"><button disabled={disabled || offset === 0} onClick={() => onPage(Math.max(0, offset - 10))}>上一批</button><span>第 {Math.floor(offset / 10) + 1} 批</span><button disabled={disabled || topic.nextOffset === null} onClick={() => onPage(topic.nextOffset!)}>下一批</button></div>}
    </>}
    <p className="path">{topic.path}</p>
  </section>;
}
