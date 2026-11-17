import { useEffect, useRef, useState } from "react";
import type { ArticleImportInput } from "./article-source";
import type { ChatImportPreview } from "./vault";
import type { BusinessApi } from "./business-panel";

export const emptyArticle: ArticleImportInput = { kind: "url", title: "", sourceName: "网页文章", url: "", content: "" };

export function ArticleImport({ api, input, setInput, busy, run, onImported, onSelect }: {
  api: BusinessApi; input: ArticleImportInput; setInput: (input: ArticleImportInput) => void; busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>; onImported: (path: string) => Promise<void>; onSelect: (path: string) => void;
}) {
  const [preview, setPreview] = useState<ChatImportPreview>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = busy || !!preview?.plan;
  function update(change: Partial<ArticleImportInput>) { setInput({ ...input, ...change }); setPreview(undefined); }
  return <>
    <h3>导入网页／Markdown</h3>
    <p>输入单篇公开网页网址，或粘贴／选择 UTF-8 Markdown 文件（最多 2 MB）。自动提取结果请先核对，确认后保存到 Inbox，再交给管家整理。</p>
    <form onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        const result = await api.planArticleImport(input);
        if (mounted.current) setPreview(result);
      });
    }}>
      <label>文章输入方式<select aria-label="文章输入方式" value={input.kind} disabled={locked} onChange={event => update({ kind: event.target.value as ArticleImportInput["kind"] })}>
        <option value="url">网页网址</option><option value="markdown">Markdown 文本／文件</option>
      </select></label>
      <label>文章标题<input aria-label="文章标题" maxLength={200} value={input.title} disabled={locked} required onChange={event => update({ title: event.target.value })} /></label>
      <label>文章来源<input aria-label="文章来源" maxLength={500} value={input.sourceName} disabled={locked} required onChange={event => update({ sourceName: event.target.value })} /></label>
      {input.kind === "url" ? <>
        <label>网页网址<input key="url" aria-label="网页网址" type="url" maxLength={2048} value={input.url} disabled={locked} required onChange={event => update({ url: event.target.value })} placeholder="https://…" /></label>
        <p>只读取公开 HTTP(S) 正文，不使用浏览器登录状态。读取失败时可切换为 Markdown 粘贴正文。</p>
      </> : <>
        <label>选择 Markdown 文件<input key="file" aria-label="选择 Markdown 文件" type="file" accept=".md,text/markdown" disabled={locked} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file) return;
          void run(async () => {
            if (!/\.md$/i.test(file.name) || file.size > 2_000_000) throw new Error("请选择不超过 2 MB 的 .md 文件。");
            const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as ArrayBuffer);
              reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
              reader.readAsArrayBuffer(file);
            });
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            if (!text.trim() || text.includes("\x00")) throw new Error("文件没有有效 Markdown 正文，请选择 UTF-8 文本。");
            if (mounted.current) update({ title: file.name.replace(/\.md$/i, ""), sourceName: file.name, content: text });
          });
        }} /></label>
        <label>Markdown 正文<textarea aria-label="Markdown 正文" rows={10} maxLength={2_000_000} value={input.content} disabled={locked} required onChange={event => update({ content: event.target.value })} /></label>
      </>}
      <button disabled={locked || !input.title.trim() || !input.sourceName.trim() || !(input.kind === "url" ? input.url.trim() : input.content.trim())}>{busy ? "正在处理文章…" : "预览文章导入"}</button>
    </form>
    {preview?.duplicate && <section className="learning-business-confirm" aria-label="重复文章">
      <p>相同原文已导入：{preview.duplicate.path}。本次不会重复保存。</p>
      <button disabled={busy} onClick={() => onSelect(preview.duplicate!.path)}>查看已导入文章</button>
    </section>}
    {preview?.plan && <section className="learning-business-confirm" aria-label="确认文章导入">
      <p>将新建 {preview.plan.path} 并保存原文快照。来源：{preview.plan.article?.sourceName}。请核对提取正文是否完整。</p>
      <pre className="learning-business-content">{preview.plan.after}</pre>
      <button disabled={busy} onClick={() => void run(async () => {
        const result = await api.execute(preview.plan!.id);
        if (result.status !== "completed") throw new Error(result.error || "导入失败，请检查活动记录。");
        if (!mounted.current) return;
        setPreview(undefined); setInput({ ...emptyArticle });
        await onImported(result.path);
      })}>确认导入文章</button>
      <button disabled={busy} onClick={() => void run(async () => {
        await api.cancelPlan(preview.plan!.id);
        if (mounted.current) setPreview(undefined);
      })}>取消文章导入</button>
    </section>}
  </>;
}
