import { isMap, isScalar, parseDocument, stringify } from "yaml";
import { markdownTree } from "./task-progress";
import type { KnowledgeMetadata, KnowledgePlanInput } from "./knowledge-synthesis";

type Unit = { key: string; start: number; end: number; text: string };
function units(content: string) {
  const result = new Map<string, Unit>(), bom = content.startsWith("\uFEFF") ? 1 : 0;
  let opening: { key: string; start: number } | undefined;
  for (const node of markdownTree(content).children) {
    if (node.type !== "html") continue;
    const marker = /^<!-- learning-knowledge:(start|end) ([a-z0-9-]+) -->$/.exec(node.value.trim());
    if (!marker) continue;
    const start = node.position!.start.offset! + bom, end = node.position!.end.offset! + bom;
    if (marker[1] === "start") {
      if (opening || result.has(marker[2])) throw new Error("Knowledge sections overlap or have duplicate keys");
      opening = { key: marker[2], start };
    } else {
      if (!opening || opening.key !== marker[2]) throw new Error("Knowledge section markers do not match");
      result.set(opening.key, { key: opening.key, start: opening.start, end, text: content.slice(opening.start, end) }); opening = undefined;
    }
  }
  if (opening) throw new Error("Knowledge section is unclosed; reread and repair the exact section");
  return result;
}
const normalize = (content: string) => content.replace(/\r\n/g, "\n");
const difference = (before: string, after: string) => {
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return { before: before.slice(start, before.length - end), after: after.slice(start, after.length - end) };
};

/** Only known metadata fields change; all other property bytes and comments remain. */
function metadataHeader(content: string, metadata: KnowledgeMetadata) {
  const opening = /^(?:\uFEFF)?---\r?\n/.exec(content), newline = content.includes("\r\n") ? "\r\n" : "\n";
  const closing = opening && /^---[ \t]*(?:\r?\n|$)/m.exec(content.slice(opening[0].length));
  if (opening && !closing) throw new Error("Knowledge target has unclosed YAML frontmatter");
  if (!opening) return `${content.startsWith("\uFEFF") ? "\uFEFF" : ""}---${newline}${stringify(metadata).replace(/\n/g, newline)}---${newline}${content.replace(/^\uFEFF/, "")}`;
  const header = content.slice(opening[0].length, opening[0].length + closing!.index), document = parseDocument(header);
  if (document.errors.length || !isMap(document.contents)) throw new Error("Knowledge target frontmatter must be a valid mapping");
  const edits: { start: number; end: number; text: string }[] = [];
  let additions = "";
  for (const [key, value] of Object.entries(metadata)) {
    const pair = document.contents.items.find(pair => isScalar(pair.key) && pair.key.value === key);
    const text = stringify({ [key]: value }).replace(/\n/g, newline);
    if (pair && isScalar(pair.key) && pair.key.range && pair.value?.range) edits.push({ start: pair.key.range[0], end: pair.value.range[2], text });
    else if (pair) throw new Error("Knowledge property cannot be updated without changing unrelated YAML");
    else additions += text;
  }
  let after = header;
  for (const edit of edits.sort((a, b) => b.start - a.start)) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  after += (after && !after.endsWith("\n") ? newline : "") + additions;
  const updated = parseDocument(after);
  if (updated.errors.length) throw new Error("Knowledge metadata update conflicts with existing YAML aliases");
  updated.toJS();
  return content.slice(0, opening[0].length) + after + content.slice(opening[0].length + closing!.index);
}

/** Three-way section merge against an existing saved operation; no extra snapshot store. */
export function mergeKnowledge(before: string, generated: string, metadata: KnowledgeMetadata, baseline: string | undefined, replacements: NonNullable<KnowledgePlanInput["replacements"]> = []) {
  const current = units(before), next = units(generated), original = units(baseline ?? "");
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  if (!next.size) throw new Error("Knowledge output has no readable generated sections");
  const overrides = new Map(replacements.map(replacement => [replacement.key, replacement.before]));
  if (overrides.size !== replacements.length) throw new Error("Duplicate knowledge replacement key");
  for (const [key, expected] of overrides) if (current.get(key)?.text !== expected) throw new Error(`Knowledge replacement must match the current section exactly: ${key}`);
  const edits: { start: number; end: number; text: string }[] = [], changes: { before: string; after: string }[] = [];
  const added: string[] = [], retained = [...current.keys()].filter(key => key.startsWith("group-") && !next.has(key) && !overrides.has(key));
  for (const [key, part] of next) {
    const existing = current.get(key), base = original.get(key);
    const text = part.text.replace(/\r?\n/g, newline);
    if (!existing) { added.push(text); changes.push({ before: "", after: text }); continue; }
    if (normalize(existing.text) === normalize(text)) continue;
    if (!overrides.has(key) && (!base || normalize(existing.text) !== normalize(base.text))) {
      if (base && normalize(part.text) === normalize(base.text)) { retained.push(key); continue; }
      throw new Error(`Knowledge section has manual edits; merge the current text and supply replacements[key,before]: ${key}`);
    }
    edits.push({ start: existing.start, end: existing.end, text }); changes.push(difference(existing.text, text));
  }
  for (const [key] of overrides) if (!next.has(key)) {
    const part = current.get(key)!; edits.push({ start: part.start, end: part.end, text: "" }); changes.push({ before: part.text, after: "" });
  }
  if (added.length) {
    const position = current.size ? current.get("relations")?.start ?? current.get("gaps")?.start ?? before.length : before.length;
    edits.push({ start: position, end: position, text: `${newline}${newline}${added.join(newline + newline)}${newline}${newline}` });
  }
  let after = before;
  for (const edit of edits.sort((a, b) => b.start - a.start)) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  if (retained.length) {
    const sourceSection = units(after).get("sources");
    if (sourceSection) {
      const offset = after.lastIndexOf("<!-- learning-knowledge:end sources -->", sourceSection.end);
      const notice = `保留了旧段落或人工修改，未按本次来源重新生成；主题暂不声明完整处理范围。旧段落的依据以各自标注的来源版本及历史保存记录为准。${newline}${newline}`;
      if (!sourceSection.text.includes(notice)) after = after.slice(0, offset) + notice + after.slice(offset);
    }
  }
  // Retained manual sections have not been regenerated against these source ranges.
  after = metadataHeader(after, retained.length ? { ...metadata, sources: metadata.sources.map(source => ({ ...source, ranges: [] })) } : metadata);
  validateKnowledgeSections(after);
  return { after, changes, retained };
}

export function validateKnowledgeSections(content: string) {
  units(content);
  const ids = new Set<string>();
  for (const node of markdownTree(content).children) {
    if (node.type !== "paragraph" || node.children.length !== 1 || node.children[0].type !== "text") continue;
    const match = /^\^([a-z0-9][a-z0-9-]{0,79})$/.exec(node.children[0].value.trim());
    if (match && ids.has(match[1])) throw new Error(`Duplicate knowledge block ID after merging; retain unique IDs: ${match[1]}`);
    if (match) ids.add(match[1]);
  }
}
