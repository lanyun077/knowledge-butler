import { useEffect, useRef, useState } from "react";
import type { BusinessApi } from "./business-panel";
import type { PdfImportInput } from "./pdf-source";
import type { ChatImportPreview, NoteDocument } from "./vault";

export function PdfImport({ api, busy, run, onImported, onSelect }: {
  api: BusinessApi; busy: boolean; run: (action: () => Promise<void>) => Promise<void>;
  onImported: (path: string) => Promise<void>; onSelect: (path: string) => void;
}) {
  const [input, setInput] = useState<PdfImportInput>({ title: "", sourceName: "", base64: "" });
  const [preview, setPreview] = useState<ChatImportPreview>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = busy || !!preview?.plan;
  return <>
    <h3>导入 PDF</h3>
    <p>选择单个正常文本 PDF（最多 5 MB、200 页）。按页提取，核对后保存原件和 Inbox 来源。暂不支持扫描件 OCR。文件仅在当前页面保留，刷新后需重新选择。</p>
    <form onSubmit={event => { event.preventDefault(); void run(async () => {
      const result = await api.planPdfImport(input);
      if (mounted.current) setPreview(result);
    }); }}>
      <label>选择 PDF 文件<input aria-label="选择 PDF 文件" type="file" accept=".pdf,application/pdf" disabled={locked} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        void run(async () => {
          if (!/\.pdf$/i.test(file.name) || file.size > 5_000_000) throw new Error("请选择不超过 5 MB 的 .pdf 文件。");
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
            reader.readAsDataURL(file);
          });
          if (mounted.current) { setInput({ title: file.name.replace(/\.pdf$/i, ""), sourceName: file.name, base64 }); setPreview(undefined); }
        });
      }} /></label>
      <label>PDF 标题<input aria-label="PDF 标题" value={input.title} maxLength={200} required disabled={locked} onChange={event => { setInput({ ...input, title: event.target.value }); setPreview(undefined); }} /></label>
      <label>PDF 来源<input aria-label="PDF 来源" value={input.sourceName} maxLength={500} required disabled={locked} onChange={event => { setInput({ ...input, sourceName: event.target.value }); setPreview(undefined); }} /></label>
      <button disabled={locked || !input.base64 || !input.title.trim() || !input.sourceName.trim()}>{busy ? "正在提取 PDF…" : "预览 PDF 导入"}</button>
    </form>
    {preview?.duplicate && <section className="learning-business-confirm" aria-label="重复 PDF">
      <p>相同原件已导入：{preview.duplicate.path}。本次不会重复保存。</p>
      <button disabled={busy} onClick={() => onSelect(preview.duplicate!.path)}>查看已导入 PDF</button>
    </section>}
    {preview?.plan && <section className="learning-business-confirm" aria-label="确认 PDF 导入">
      <p>将新建 {preview.plan.path} 并保存原 PDF。请逐页核对，复杂排版、表格和图片可能无法完整提取。</p>
      <pre className="learning-business-content">{preview.plan.after}</pre>
      <button disabled={busy} onClick={() => void run(async () => {
        const result = await api.execute(preview.plan!.id);
        if (result.status !== "completed") throw new Error(result.error || "PDF 导入失败，请检查活动记录。");
        if (!mounted.current) return;
        setPreview(undefined); setInput({ title: "", sourceName: "", base64: "" });
        await onImported(result.path);
      })}>确认导入 PDF</button>
      <button disabled={busy} onClick={() => void run(async () => {
        await api.cancelPlan(preview.plan!.id);
        if (mounted.current) setPreview(undefined);
      })}>取消 PDF 导入</button>
    </section>}
  </>;
}

export function PdfOriginalLinks({ api, note, busy, run }: {
  api: BusinessApi; note: NoteDocument; busy: boolean; run: (action: () => Promise<void>) => Promise<void>;
}) {
  const [original, setOriginal] = useState<{ url: string; pages: number }>();
  const [page, setPage] = useState(1);
  const mounted = useRef(true);
  const url = useRef<string>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (url.current) URL.revokeObjectURL(url.current); }; }, []);
  if (!/^type: ["']?pdf-source["']?\r?$/m.test(note.content)) return null;
  return <section aria-label="PDF 原件">
    {!original ? <button disabled={busy} onClick={() => void run(async () => {
      const result = await api.readPdf(note.path, note.version);
      if (!mounted.current) return;
      const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
      url.current = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      setOriginal({ url: url.current, pages: result.pages });
    })}>加载原 PDF 与页码链接</button> : <>
      <p><a href={original.url} target="_blank" rel="noopener noreferrer">查看原 PDF</a> · <a href={original.url} download={`${note.title}.pdf`}>下载原 PDF</a></p>
      <label>原 PDF 页码<select aria-label="原 PDF 页码" value={page} onChange={event => setPage(Number(event.target.value))}>{Array.from({ length: original.pages }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}</select></label>
      <a href={`${original.url}#page=${page}`} target="_blank" rel="noopener noreferrer">打开所选页</a>
    </>}
  </section>;
}
