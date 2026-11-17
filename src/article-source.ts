import { HttpFetchProvider } from "@deepseek-ai/dsh-web-fetch-http";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export interface ArticleImportInput {
  kind: "url" | "markdown";
  title: string;
  sourceName: string;
  url: string;
  content: string;
}
export interface ArticleSource {
  sourceName: string;
  submittedUrl?: string;
  finalUrl?: string;
  sourceTitle?: string;
  author?: string;
  raw: string;
  markdown: string;
  format: "html" | "markdown";
  extractor: string;
}

const fetcher = new HttpFetchProvider({ maxResponseBytes: 2_000_000, maxBodyChars: 2_000_000,
  timeoutMs: 30_000, maxRedirects: 5, userAgent: "dsh-learning-os/article-import" });

export function validateArticleText(content: string): void {
  if (!content.trim() || content.length > 2_000_000 || content.includes("\x00")
    || Buffer.from(content, "utf8").toString("utf8") !== content) throw new Error("文章必须为非空 UTF-8 文本，最多 2000000 字符。");
}

export async function prepareArticle(input: ArticleImportInput, signal?: AbortSignal): Promise<ArticleSource> {
  signal?.throwIfAborted();
  if (!input.title.trim() || input.title.length > 200 || /[/\\\r\n]/.test(input.title)) throw new Error("文章标题必须是有效文件名。");
  if (!input.sourceName.trim() || input.sourceName.length > 500 || /[\r\n\x00]/.test(input.sourceName)) throw new Error("请填写单行来源名称。");
  const sourceName = input.sourceName.trim();
  if (input.kind === "markdown") {
    validateArticleText(input.content);
    return { sourceName, raw: input.content, markdown: input.content, format: "markdown", extractor: "markdown-text-v1" };
  }
  if (input.kind !== "url") throw new Error("不支持的文章来源类型。");
  const result = await fetcher.fetch({ url: input.url.trim() }, signal);
  signal?.throwIfAborted();
  if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`网页读取失败（HTTP ${result.statusCode}），请检查网址或粘贴 Markdown 正文。`);
  if (result.truncated) throw new Error("网页超过读取上限，未保存不完整内容。请粘贴 Markdown 正文。");
  validateArticleText(result.body.content);
  const base = { sourceName, submittedUrl: input.url.trim(), finalUrl: result.url, raw: result.body.content };
  if (result.body.kind === "text") return { ...base, markdown: base.raw, format: "markdown", extractor: "web-text-v1" };
  const { document } = parseHTML(base.raw);
  // Parsing is inert: no scripts, subresource requests or browser credentials.
  document.querySelectorAll('script,style,noscript,iframe,form,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
  // Some documentation sites use block elements inside code instead of pre.
  // Normalize those before Readability/Turndown collapse their line boundaries.
  document.querySelectorAll("code").forEach(node => {
    if (!node.querySelector("div,p,br")) return;
    const text = (part: Node): string => part.nodeType === 3 ? part.textContent ?? ""
      : part.nodeName === "BR" ? "\n"
      : Array.from(part.childNodes).map(text).join("") + (["DIV", "P"].includes(part.nodeName) ? "\n" : "");
    const value = text(node as unknown as Node).replace(/\n$/, "");
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = value;
    pre.append(code); (node.closest("pre") ?? node).replaceWith(pre);
  });
  document.querySelectorAll("a[href]").forEach(node => {
    try {
      const url = new URL(node.getAttribute("href")!, result.url);
      if (["http:", "https:"].includes(url.protocol)) node.setAttribute("href", url.href);
      else node.removeAttribute("href");
    } catch { node.removeAttribute("href"); }
  });
  const article = new Readability(document as unknown as Document).parse();
  if (!article?.content || !article.textContent?.trim()) throw new Error("未能提取文章正文；登录页或需要脚本的页面请改为粘贴 Markdown 正文。");
  const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  converter.addRule("image-description", { filter: "img", replacement: (_content, node) => {
    const alt = (node as HTMLElement).getAttribute("alt");
    return alt ? `［图片：${alt}］` : "［图片］";
  } });
  // Pass the inert DOM rather than letting Turndown create another browser DOM.
  const content = parseHTML(`<html><body>${article.content}</body></html>`).document.body;
  const markdown = converter.turndown(content as unknown as HTMLElement);
  validateArticleText(markdown);
  return { ...base, markdown, format: "html", sourceTitle: article.title || undefined,
    author: article.byline || undefined, extractor: "readability-0.6.0_turndown-7.2.0_v1" };
}
