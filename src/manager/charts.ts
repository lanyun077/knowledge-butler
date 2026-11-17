import { Markmap } from "markmap-view";
import type { IPureNode } from "markmap-common";
import type { KnowledgeTopicItem, KnowledgeTopicRelation } from "../knowledge-organization-contract";
export type TopicChart = { title: string; items: KnowledgeTopicItem[]; relations: KnowledgeTopicRelation[] };
const escapeLabel = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const label = (value: string) => value.length > 36 ? value.slice(0, 36) + "…" : value;

export type Selection = { kind: "item"; id: string } | { kind: "relation"; index: number };
export type Chart = { fit(): void; destroy(): void };

export function mindmapData(topic: TopicChart): IPureNode {
  const groups = [...new Set(topic.items.map(item => item.group))];
  return { content: escapeLabel(label(topic.title)), children: groups.map(group => ({ content: escapeLabel(label(group)), children: topic.items.filter(item => item.group === group).map(item => ({
    content: `<button type="button" data-item="${escapeLabel(item.id)}">${escapeLabel(label(item.title))}</button>`, children: [],
  })) })) };
}

export function drawMindmap(container: HTMLElement, topic: TopicChart, select: (selection: Selection) => void): Chart {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-label", "按知识分组的思维导图");
  container.append(svg);
  const map = Markmap.create(svg, { duration: 0, autoFit: true, maxWidth: 160, spacingHorizontal: 64, spacingVertical: 16,
    color: () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  }, mindmapData(topic));
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-item]");
    if (button) select({ kind: "item", id: button.dataset.item! });
  };
  container.addEventListener("click", click);
  const resize = new ResizeObserver(() => { void map.fit(); });
  resize.observe(container);
  return { fit: () => { void map.fit(); }, destroy: () => { resize.disconnect(); container.removeEventListener("click", click); map.destroy(); svg.remove(); } };
}
