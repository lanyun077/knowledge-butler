import { markdownTree } from "./task-progress";

export interface HandoffMetadata {
  templateVersion: 1; title: string; generatedAt: string; client: string; sourceProject: string;
  declaredProjectPath: string; conversationTitle: string; conversation: string; coverage: string; gaps: string; selection: string;
  missingFields: string[];
}
export interface HandoffCapture { path: string; version: string; duplicate: boolean; sourceHash: string;
  status: "received" | "needs-supplement"; missingFields: string[]; projectPath?: string; previousSource?: string }
const labels = { title: "文档标题", generatedAt: "生成日期与时区", client: "来源客户端", sourceProject: "来源项目名称与本地目录",
  declaredProjectPath: "对应Vault项目笔记", conversationTitle: "原会话标题", conversation: "原会话标识或可打开链接",
  coverage: "本文覆盖", gaps: "已知缺口", selection: "内容取舍" } as const;
const unknown = (value: string | undefined) => !value || ["未知", "未取得", "无"].includes(value);
interface TextNode { type: string; value?: string; children?: TextNode[] }

export function parseHandoff(content: string): HandoffMetadata {
  if (!content.trim() || Buffer.byteLength(content, "utf8") > 2_000_000 || content.includes("\0")
    || Buffer.from(content, "utf8").toString("utf8") !== content) throw new Error("Handoff must be nonempty UTF-8 Markdown up to 2000000 bytes; do not truncate it");
  const tree = markdownTree(content);
  const text = (node: TextNode): string => node.value ?? (node.children ?? []).map(text).join("");
  const fields = new Map<string, string>();
  const sections = new Set<number>();
  let inSource = false;
  for (const node of tree.children ?? []) {
    if (node.type === "heading" && node.depth === 2) {
      const section = /^(\d)\.\s/.exec(text(node));
      if (section) sections.add(Number(section[1]));
      inSource = /^1\.\s*来源与覆盖$/.test(text(node));
    } else if (inSource && node.type === "list") {
      for (const item of node.children ?? []) {
        const match = /^([^：:]+)[：:]\s*([\s\S]*)$/.exec(text(item).trim());
        if (!match) continue;
        if (fields.has(match[1])) throw new Error(`Duplicate handoff field: ${match[1]}`);
        fields.set(match[1], match[2].trim());
      }
    }
  }
  if (fields.get("模板版本") !== "1") throw new Error("Handoff requires template version 1 in section 1; use learning_handoff_template");
  const values = Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, fields.get(label) ?? "未知"])) as Omit<HandoffMetadata, "templateVersion" | "missingFields">;
  const missingFields: string[] = ["title", "generatedAt", "client", "sourceProject", "coverage"].filter(key => unknown(values[key as keyof typeof values])).map(key => labels[key as keyof typeof labels]);
  for (const key of ["gaps", "selection"] as const) if (!fields.get(labels[key])) missingFields.push(labels[key]);
  for (let section = 2; section <= 9; section++) if (!sections.has(section)) missingFields.push(`第${section}节`);
  return { ...values, title: unknown(values.title) ? "交接文档" : values.title, templateVersion: 1, missingFields };
}
