import { markdownTree } from "./task-progress";
import type { KnowledgeTopicItem, KnowledgeTopicRelation } from "./knowledge-organization-contract";

type Node = { type: string; value?: string; depth?: number; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
const text = (node: Node): string => node.type === "html" || node.type === "code" ? "" : node.value ?? node.children?.map(text).join("") ?? "";
const compact = (value: string, length: number) => value.replace(/\s+/g, " ").trim().slice(0, length);

/** Parse the current generated sections, including manual edits. Fenced examples are never knowledge. */
export function parseKnowledgeTopic(content: string) {
  const source = content.replace(/^\uFEFF/, "");
  const blockId = (node: Node) => node.type === "paragraph" && node.children?.length === 1 && node.children[0].type === "text"
    ? /^\^([a-zA-Z0-9-]+)$/.exec(source.slice(node.position?.start.offset, node.position?.end.offset).trim())?.[1] : undefined;
  const items: KnowledgeTopicItem[] = [], relations: KnowledgeTopicRelation[] = [];
  const overview: string[] = [];
  let section = "", group = "", current: { title: string; nodes: Node[] } | undefined;
  const flush = () => {
    if (!current) return;
    const ids = current.nodes.map(blockId).filter(Boolean);
    if (ids.length === 1) {
      const paragraphs = current.nodes.filter(node => !blockId(node));
      const evidence = paragraphs.filter(node => text(node).startsWith("出处：")).map(text).join(" ");
      items.push({ id: ids[0]!, title: compact(current.title, 240), group, summary: compact(paragraphs.filter(node => !text(node).startsWith("出处：")).map(text).join(" "), 400), evidence: compact(evidence, 600) });
    }
    current = undefined;
  };
  for (const node of markdownTree(content).children as Node[]) {
    if (node.type === "html") {
      const marker = /^<!-- learning-knowledge:(start|end) ([a-z0-9-]+) -->$/.exec(node.value?.trim() ?? "");
      if (marker) { flush(); section = marker[1] === "start" ? marker[2] : ""; group = ""; }
      continue;
    }
    if (section.startsWith("group-")) {
      if (node.type === "heading" && node.depth! <= 3) {
        flush();
        if (node.depth === 2) group = compact(text(node), 240);
        if (node.depth === 3) current = { title: text(node), nodes: [] };
      } else current?.nodes.push(node);
    }
    if (section === "overview" && node.type !== "heading") overview.push(text(node));
    if (section === "relations" && node.type === "table") {
      for (const row of node.children?.slice(1) ?? []) {
        const cells = row.children?.map(text) ?? [];
        const target = (index: number) => row.children?.[index].children?.every(child => child.type === "text")
          ? /^\[\[#\^([a-zA-Z0-9-]+)\]\]$/.exec(cells[index]?.trim() ?? "")?.[1] : undefined;
        const from = target(0), to = target(2);
        if (from && to && ["引用", "包含", "前置依赖", "应用于", "补充", "冲突", "相关"].includes(cells[1]))
          relations.push({ from, to, type: cells[1] as KnowledgeTopicRelation["type"], inferred: !cells[3]?.startsWith("显式："), evidence: compact(cells[3] ?? "", 600) });
      }
    }
  }
  flush();
  // Duplicate block IDs cannot be resolved reliably after a manual edit.
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const unique = items.filter(item => counts.get(item.id) === 1);
  const ids = new Set(unique.map(item => item.id));
  const valid = relations.filter(relation => ids.has(relation.from) && ids.has(relation.to));
  return { items: unique, relations: valid, invalidRelations: relations.length - valid.length, summary: compact(overview.join(" "), 180) };
}
