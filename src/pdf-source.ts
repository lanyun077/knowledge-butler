import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfImportInput { title: string; sourceName: string; base64: string }
export interface PdfSource { sourceName: string; base64: string; hash: string; pages: string[] }
export interface PdfOriginal { base64: string; pages: number; sourceName: string }
export const maxPdfBytes = 5_000_000;
const pdfRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

export function pdfBytes(base64: string): Buffer {
  if (!base64 || base64.length > Math.ceil(maxPdfBytes / 3) * 4) throw new Error("PDF 文件编码无效或超过 5 MB。");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw new Error("PDF 文件编码无效。");
  if (bytes.length > maxPdfBytes || bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("请选择不超过 5 MB 的 PDF 文件。");
  return bytes;
}

export async function preparePdf(input: PdfImportInput, signal?: AbortSignal): Promise<PdfSource> {
  if (!input.title.trim() || input.title.length > 200 || /[/\\\r\n]/.test(input.title)) throw new Error("PDF 标题必须是有效文件名。");
  if (!input.sourceName.trim() || input.sourceName.length > 500 || /[\r\n\x00]/.test(input.sourceName)) throw new Error("请填写单行来源名称。");
  signal?.throwIfAborted();
  const bytes = pdfBytes(input.base64);
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, useWorkerFetch: false,
    cMapUrl: join(pdfRoot, "cmaps").replace(/\\/g, "/") + "/", cMapPacked: true,
    standardFontDataUrl: join(pdfRoot, "standard_fonts").replace(/\\/g, "/") + "/" });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const document = await task.promise;
    if (document.numPages > 200) throw new Error("PDF 超过 200 页，请拆分后导入。");
    const pages: string[] = [];
    let length = 0;
    for (let number = 1; number <= document.numPages; number++) {
      signal?.throwIfAborted();
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      length += text.length;
      if (length > 2_000_000) throw new Error("PDF 提取正文超过 2000000 字符，请拆分后导入。");
      pages.push(text);
      page.cleanup();
    }
    if (!pages.some(text => text.trim())) throw new Error("PDF 没有可提取文本，可能是扫描件；当前不支持 OCR。");
    return { sourceName: input.sourceName.trim(), base64: input.base64, hash: createHash("sha256").update(bytes).digest("hex"), pages };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === "PasswordException") throw new Error("PDF 已加密，请先解密后导入。");
    if (error instanceof Error && ["InvalidPDFException", "UnknownErrorException"].includes(error.name)) throw new Error("PDF 损坏或无法读取，请检查文件。");
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await task.destroy();
  }
}
