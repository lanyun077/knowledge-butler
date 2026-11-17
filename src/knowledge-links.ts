import { posix } from "node:path";
import { markdownTree } from "./task-progress";
import type { KnowledgeLink, KnowledgeOutline } from "./knowledge-organization-contract";

type Node = { type: string; value?: string; children?: Node[]; depth?: number; url?: string; identifier?: string; position?: { start: { line: number; offset?: number }; end: { offset?: number } } };
export interface ParsedKnowledge { links: Omit<KnowledgeLink, "state" | "targetPath">[]; outline: KnowledgeOutline[] }

/** Only actual Markdown links and wiki links in text; code, images and HTML stay inert. */
export function parseKnowledgeLinks(path: string, content: string): ParsedKnowledge {
  const tree = markdownTree(content), links: ParsedKnowledge["links"] = [], outline: KnowledgeOutline[] = [];
  const definitions = new Map<string, string>();
  function definitionsIn(node: Node) {
    if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url);
    node.children?.forEach(definitionsIn);
  }
  definitionsIn(tree);
  const text = (node: Node): string => node.value ?? node.children?.map(text).join("") ?? "";
  function visit(node: Node) {
    if (["code", "inlineCode", "html", "yaml", "image", "imageReference", "definition"].includes(node.type)) return;
    if (node.type === "heading") outline.push({ title: text(node).slice(0, 240), depth: node.depth!, line: node.position!.start.line });
    if (node.type === "link" || node.type === "linkReference") {
      const target = node.url ?? definitions.get(node.identifier?.toLowerCase() ?? "");
      if (target && !/^[a-z][\w+.-]*:/i.test(target) && !target.startsWith("//")) links.push({ sourcePath: path, target: target.slice(0, 4097), label: text(node).slice(0, 240), line: node.position?.start.line, origin: "markdown", format: "markdown" });
      return;
    }
    if (node.type === "text" && node.position?.start.offset !== undefined) {
      const bom = content.startsWith("\uFEFF") ? 1 : 0;
      const raw = content.slice(node.position.start.offset + bom, (node.position.end.offset ?? 0) + bom);
      for (const match of raw.matchAll(/(?<![\\!])\[\[([^\]\n]+)\]\]/g)) {
        const [target, ...alias] = match[1].split("|");
        links.push({ sourcePath: path, target: target.slice(0, 4097), ...(alias.length ? { label: alias.join("|").slice(0, 240) } : {}),
          line: node.position.start.line + raw.slice(0, match.index).split("\n").length - 1, origin: "markdown", format: "wiki" });
      }
    }
    node.children?.forEach(visit);
  }
  visit(tree);
  return { links, outline };
}

export function resolveKnowledgeLink(link: ParsedKnowledge["links"][number], paths: string[], isMapped: (path: string) => boolean): KnowledgeLink {
  if (link.target.length > 4096) return { ...link, target: link.target.slice(0, 4096), state: "unsupported" };
  let target: string, fragment: string | undefined;
  const split = link.target.indexOf("#");
  try {
    const name = split < 0 ? link.target : link.target.slice(0, split), location = split < 0 ? undefined : link.target.slice(split + 1);
    target = link.format === "markdown" ? decodeURIComponent(name) : name;
    fragment = link.format === "markdown" && location ? decodeURIComponent(location) : location;
  } catch { return { ...link, state: "unsupported" }; }
  const result = { ...link, ...(fragment ? { fragment } : {}) };
  if (!target) return { ...result, targetPath: link.sourcePath, state: "resolved" };
  if (target.includes("\\") || /^[a-z][\w+.-]*:/i.test(target)) return { ...result, state: "unsupported" };
  if (link.format === "markdown" && posix.extname(target) && !/\.md$/i.test(target)) return { ...result, state: "unsupported" };
  const withExtension = /\.md$/i.test(target) ? target : `${target}.md`;
  const candidates = (link.format === "markdown" && !target.startsWith("/")) || target.startsWith(".") ? [posix.normalize(posix.join(posix.dirname(link.sourcePath), withExtension))]
    : target.startsWith("/") ? [withExtension.slice(1)]
    : target.includes("/") ? [isMapped(withExtension) ? withExtension : posix.normalize(posix.join(posix.dirname(link.sourcePath), withExtension))]
    : paths.filter(path => posix.basename(path).toLowerCase() === withExtension.toLowerCase());
  const mapped = candidates.filter(isMapped);
  const exact = mapped.filter(path => paths.includes(path));
  const matches = [...new Set(exact.length ? exact : paths.filter(path => mapped.some(candidate => candidate.toLowerCase() === path.toLowerCase())))];
  if (matches.length === 1) return { ...result, targetPath: matches[0], state: "resolved" };
  if (matches.length > 1) return { ...result, state: "ambiguous" };
  return { ...result, state: candidates.length && !mapped.length ? "outside-scope" : "missing" };
}
