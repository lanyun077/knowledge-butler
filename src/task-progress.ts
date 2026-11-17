import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);
export const markdownTree = (content: string) => parser.parse(content.replace(/^\uFEFF/, ""));
export interface TaskProgress { completed: number; total: number }

export function markdownTasks(content: string) {
  const tasks: { line: number; checked: boolean; text: string; markerOffset: number }[] = [];
  function visit(node: { type: string; checked?: boolean | null; position?: { start: { line: number; offset?: number } }; children?: typeof node[] }) {
    if (node.type === "listItem" && typeof node.checked === "boolean" && node.position?.start.offset !== undefined) {
      const start = node.position.start.offset + (content.startsWith("\uFEFF") ? 1 : 0);
      const marker = /^([-+*]|\d+[.)])([ \t]+)\[([ xX])\]/.exec(content.slice(start));
      if (marker) {
        const markerOffset = start + marker[1].length + marker[2].length + 1;
        tasks.push({ line: node.position.start.line, checked: node.checked,
          text: content.slice(start + marker[0].length).split(/\r?\n/, 1)[0].trim().slice(0, 200), markerOffset });
      }
    }
    node.children?.forEach(visit);
  }
  visit(markdownTree(content));
  return tasks;
}

export function taskProgress(content: string): TaskProgress {
  const progress = { completed: 0, total: 0 };
  function visit(node: { type: string; checked?: boolean | null; children?: typeof node[] }) {
    if (node.type === "listItem" && typeof node.checked === "boolean") {
      progress.total++;
      if (node.checked) progress.completed++;
    }
    node.children?.forEach(visit);
  }
  visit(markdownTree(content));
  return progress;
}
