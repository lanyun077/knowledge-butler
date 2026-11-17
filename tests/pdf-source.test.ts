import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { pdfBytes, preparePdf } from "../src/pdf-source";
import { VaultService } from "../src/vault";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const input = async () => ({ title: "PDF 来源", sourceName: "验收.pdf", base64: (await fixture("text-source.pdf")).toString("base64") });
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function vault() { const root = await mkdtemp(join(tmpdir(), "pdf-intake-")); roots.push(root); return { root, service: new VaultService(root) }; }

describe("PDF source intake", () => {
  it("extracts real Chinese text per page and hashes original bytes", async () => {
    const data = await input();
    const source = await preparePdf(data);
    expect(source.pages).toHaveLength(2);
    expect(source.pages[0]).toContain("保留来源原件");
    expect(source.pages[1]).toContain("长期知识应检索既有笔记");
    expect(source.pages[0]).not.toContain("长期知识应检索既有笔记");
    expect(source.hash).toBe(createHash("sha256").update(Buffer.from(data.base64, "base64")).digest("hex"));
  });

  it("rejects oversized, corrupt, encrypted, image-only/blank and too-many-page input", async () => {
    const limit = Buffer.alloc(5_000_000); limit.write("%PDF-");
    expect(pdfBytes(limit.toString("base64")).equals(limit)).toBe(true);
    expect(() => pdfBytes("A".repeat(6_666_672))).toThrow("5 MB");
    expect(() => pdfBytes("not base64")).toThrow();
    const data = await input();
    await expect(preparePdf({ ...data, base64: Buffer.from("%PDF-1.7\nbroken").toString("base64") })).rejects.toThrow("损坏");
    for (const [name, error] of [["encrypted.pdf", "加密"], ["blank.pdf", "OCR"], ["too-many-pages.pdf", "200 页"]]) {
      await expect(preparePdf({ ...data, base64: (await fixture(name!)).toString("base64") })).rejects.toThrow(error);
    }
    const controller = new AbortController(); controller.abort();
    await expect(preparePdf(data, controller.signal)).rejects.toThrow();
  });

  it("previews without writing, cancels, confirms once, locates duplicates and opens exact original", async () => {
    const { root, service } = await vault();
    const source = await preparePdf(await input());
    const cancelled = (await service.planPdfImport("取消 PDF", source)).plan!;
    await expect(readFile(join(root, cancelled.path))).rejects.toThrow();
    await expect(readFile(join(root, cancelled.pdf!.snapshotPath))).rejects.toThrow();
    await service.cancelPlan(cancelled.id);
    await expect(service.execute(cancelled.id)).rejects.toThrow("Plan changed");
    const plan = (await service.planPdfImport("PDF 来源", source)).plan!;
    expect(plan.after).toContain("## PDF 第 2 页");
    expect(plan.after).toContain("#page=2");
    expect((await service.execute(plan.id)).status).toBe("completed");
    expect(await service.execute(plan.id)).toEqual(await service.execute(plan.id));
    const note = await service.read(plan.path);
    expect((await service.readPdf(note.path, note.version)).base64).toBe(source.base64);
    expect(await readFile(join(root, plan.pdf!.snapshotPath))).toEqual(Buffer.from(source.base64, "base64"));
    expect((await service.planPdfImport("其他标题", source)).duplicate?.path).toBe(plan.path);
    await expect(service.readPdf(note.path, "stale")).rejects.toThrow("changed");
    await writeFile(join(root, plan.pdf!.snapshotPath), "%PDF-tampered");
    await expect(service.readPdf(note.path, note.version)).rejects.toThrow("changed");
  });

  it("refuses name races, modified snapshots and forged original paths", async () => {
    const { root, service } = await vault();
    const source = await preparePdf(await input());
    const plan = (await service.planPdfImport("PDF 来源", source)).plan!;
    await service.capture("PDF 来源", "external content");
    expect((await service.execute(plan.id)).status).toBe("failed");
    await expect(service.planPdfImport("PDF 来源", source)).rejects.toThrow("已存在");
    const second = (await service.planPdfImport("新标题", source)).plan!;
    await mkdir(join(root, ".ai-learning-os/sources"), { recursive: true });
    await writeFile(join(root, second.pdf!.snapshotPath), "%PDF-other");
    expect((await service.execute(second.id)).error).toContain("snapshot changed");
    const forged = await service.capture("伪造", `---\ntype: pdf-source\nsourceHash: ${source.hash}\npageCount: 2\nrawSource: ../secret.pdf\n---\n`);
    await expect(service.readPdf(forged.path, forged.version)).rejects.toThrow("metadata");
  });
});
