import { z } from "zod";
import type { ParsedKnowledge } from "./knowledge-links";
import type { KnowledgeNote, KnowledgeLink } from "./knowledge-organization-contract";
import type { parseKnowledgeTopic } from "./knowledge-topic";

export const starNode = z.object({ id: z.string(), title: z.string(), kind: z.enum(["domain", "topic", "note"]), group: z.number(),
  parent: z.string().optional(), domain: z.string(), color: z.string(), summary: z.string().max(400), path: z.string(), version: z.string(), uri: z.string() });
export const starLink = z.object({ id: z.string(), source: z.string(), target: z.string(), type: z.string(), origin: z.string().optional(),
  inferred: z.boolean().optional(), evidence: z.string().optional() });
const page = <T extends z.ZodType>(schema: T) => z.object({ items: z.array(schema), total: z.number(), nextOffset: z.number().nullable() });
export const starPage = z.object({ version: z.string(), nodes: page(starNode), links: page(starLink),
  domains: page(z.object({ id: z.string(), title: z.string(), color: z.string() })), nextOffset: z.number().nullable() });
export type StarPage = z.infer<typeof starPage>;
export type StarData = { nodes: z.infer<typeof starNode>[]; links: z.infer<typeof starLink>[]; domains: StarPage["domains"]["items"] };
export type StarNote = KnowledgeNote & Pick<ParsedKnowledge, "outline"> & { organized?: ReturnType<typeof parseKnowledgeTopic> };

/** Display hierarchy comes from saved topics/groups, never from matching words. */
export function projectStars(notes: StarNote[], citations: KnowledgeLink[], openUri: (path: string) => string): StarData {
  const nodes: StarData["nodes"] = [], links: StarData["links"] = [], domains: StarData["domains"] = [];
  const stars = new Map<string, string>(), blocks = new Map<string, string>();
  const palette = ["#a8c1ea", "#91c2b9", "#deb995", "#c2b4dc", "#9fc5a0", "#dccb8e", "#d6a5b0", "#a4b5cf"];
  const edge = (source: string, target: string, type: string, extra = {}) => links.push({ id: `e${links.length}`, source, target, type, ...extra });
  notes.forEach((note, group) => {
    const id = `g${group}`, color = palette[group % palette.length]; stars.set(note.path, id);
    domains.push({ id, title: note.title, color });
    const common = { group, domain: note.title, color, path: note.path, version: note.version, uri: openUri(note.path) };
    nodes.push({ ...common, id, title: note.title, kind: "domain", summary: note.summary.slice(0, 400) });
    const groups = note.organized?.items.length ? [...new Set(note.organized.items.map(item => item.group))] : note.outline.filter(item => item.depth === 2).map(item => item.title);
    groups.forEach((title, index) => {
      const topic = `${id}t${index}`;
      nodes.push({ ...common, id: topic, parent: id, title, kind: "topic", summary: "已保存笔记中的分组目录。" }); edge(id, topic, "包含");
      for (const item of note.organized?.items.filter(item => item.group === title) ?? []) {
        const leaf = `${note.path}#^${item.id}`; blocks.set(leaf, leaf);
        nodes.push({ ...common, id: leaf, parent: topic, title: item.title, kind: "note", summary: item.summary.slice(0, 400) }); edge(topic, leaf, "包含");
      }
    });
  });
  for (const note of notes) for (const relation of note.organized?.relations ?? []) {
    const source = blocks.get(`${note.path}#^${relation.from}`), target = blocks.get(`${note.path}#^${relation.to}`);
    if (source && target) edge(source, target, relation.type, { origin: "organized", inferred: relation.inferred, evidence: relation.evidence });
  }
  for (const citation of citations) {
    const source = stars.get(citation.sourcePath), target = blocks.get(`${citation.targetPath}#${citation.fragment}`) ?? stars.get(citation.targetPath!);
    if (citation.state === "resolved" && source && target && citation.sourcePath !== citation.targetPath && !links.some(link => link.source === source && link.target === target && link.type === "引用"))
      edge(source, target, "引用", { origin: citation.origin, inferred: false, evidence: `${citation.sourcePath}${citation.line ? `:${citation.line}` : ""}` });
  }
  return { nodes, links, domains };
}
