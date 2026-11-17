import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [plugin, demo] = process.argv.slice(2);
if (!plugin || !demo || process.argv.length !== 4) throw new Error("Pass plugin and synthetic demo directories");
const require = createRequire(join(plugin, "package.json"));
const load = specifier => import(pathToFileURL(require.resolve(specifier)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await load("@modelcontextprotocol/sdk/client/stdio.js");
const { ElicitRequestSchema } = await load("@modelcontextprotocol/sdk/types.js");
const config = JSON.parse(await readFile(join(demo, "connection.json"), "utf8"));
assert.equal(config.vaultRoot, join(demo, "vault"), "Only use the generated synthetic Vault");
assert.match(await readFile(join(config.vaultRoot, "Inbox", "合成交接.md"), "utf8"), /合成试件/);
const response = { action: "decline" };
let message = "";
const clients = [];
const connect = async () => {
  const client = new Client({ name: "synthetic-install-check", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, request => { message = request.params.message; return response; });
  clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [join(plugin, "dist", "knowledge-launcher.js"), "stdio", "--config", join(demo, "connection.json")], stderr: "inherit" }));
  return client;
};
const stop = () => {
  const result = spawnSync(process.execPath, [join(plugin, "dist", "knowledge-launcher.js"), "stop", "--config", join(demo, "connection.json")], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
};
try {
  for (let i = 0; i < 2; i++) await connect();
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
    return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === "text").text);
  };
  assert.deepEqual(await call(clients[0], "learning_status"), await call(clients[1], "learning_status"));
  const uiTool = (await clients[0].listTools()).tools.find(tool => tool.name === "learning_open_manager");
  assert.equal(uiTool?._meta?.ui?.resourceUri, "ui://learning-os/manager-u2-v4.html");
  const ui = await clients[0].readResource({ uri: uiTool._meta.ui.resourceUri });
  assert.equal(ui.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.ok(ui.contents[0].text.includes("<script>"));
  const home = await call(clients[0], "learning_open_manager");
  const refreshed = await call(clients[0], "learning_manager_probe", { view: "home" });
  assert.equal(home.stage, "U2");
  assert.deepEqual(refreshed.management, home.management);
  const body = await call(clients[0], "learning_manager_probe", { view: "detail", path: "Wiki/版本检查.md" });
  assert.equal(body.detail.path, "Wiki/版本检查.md");
  assert.match(body.detail.version, /^[a-f0-9]{64}$/);
  assert.deepEqual((await call(clients[1], "learning_open_manager")).management, refreshed.management);
  const original = await call(clients[0], "learning_read", { path: "Wiki/版本检查.md" });
  const marker = `Synthetic install check ${Date.now()}: ordinary save without a second prompt.`;
  const plan = await call(clients[0], "learning_plan_business", { input: { operation: "daily", date: "2099-01-01", content: marker } });
  const identity = { planId: plan.planId, revision: plan.revision };
  const preview = await call(clients[1], "learning_preview", identity);
  const result = await call(clients[0], "learning_request_confirmation", identity);
  assert.equal(result.status, "completed");
  assert.equal(result.confirmation, "not-required");
  assert.equal(message, "", "Ordinary saves must not request elicitation");
  assert.equal((await call(clients[1], "learning_request_confirmation", identity)).status, "completed");
  assert.equal((await call(clients[1], "learning_request_confirmation", identity)).status, "completed");
  const saved = await call(clients[1], "learning_read", { path: "Daily/2099-01-01.md" });
  assert.equal(saved.content.split(marker).length - 1, 1);
  assert.equal(saved.content, preview.plan.after);
  assert.equal((await call(clients[0], "learning_read", { path: "Wiki/版本检查.md" })).content, original.content);
  const guide = await call(clients[0], "learning_routines", { timeZone: "Asia/Shanghai" });
  assert.equal(guide.setupOnly, true);
  // Deterministic drafts exercise the installed pipeline, not model quality.
  const notices = await readFile(join(plugin, "dist", "knowledge-manager.NOTICES.txt"), "utf8");
  for (const name of ["three@0.187.0", "3d-force-graph@1.80.2", "markmap-common@0.18.9", "markmap-view@0.18.13"]) assert.ok(notices.includes(name));
  const short = await call(clients[0], "learning_manager_probe", { view: "summary", path: body.detail.path });
  assert.equal(short.detail.content, "");
  assert.ok(short.detail.openUri.startsWith("obsidian://open?path="));
  const sky = await call(clients[0], "learning_manager_probe", { view: "universe" });
  assert.ok(sky.sky.nodes.items.some(node => node.path === body.detail.path && node.kind === "domain"));
  const template = await clients[0].readResource({ uri: "learning://templates/knowledge-organize-v1" });
  assert.ok(template.contents[0].text.includes("knowledge-organize-v1"));
  const suffix = Date.now();
  const paths = [`Projects/接口 A ${suffix}.md`, `Projects/接口 B ${suffix}.md`, `Learning/版本 ${suffix}.md`, `Learning/条件 ${suffix}.md`, `Inbox/材料 ${suffix}.md`];
  const texts = [
    `# 项目 A\n接口使用版本。\n[[${paths[1]}]]\n[[${paths[4]}]]\n[[不存在]]\n\`[[伪链接]]\`\n`,
    "# 项目 B\n接口使用版本，但内部实验允许破坏性修改。\n",
    "# 学习版本\n公共接口必须兼容旧调用。\n",
    "# 学习条件\n实验接口不承诺兼容；版本也可指文档修订。\n",
    "# 零散材料\n版本需要明确适用条件。\n" + "长文背景。".repeat(2000),
  ];
  for (let i = 0; i < paths.length; i++) await writeFile(join(config.vaultRoot, paths[i]), texts[i]);
  const scope = { projectPaths: paths.slice(0, 2), learningPaths: paths.slice(2, 4), sourcePaths: [paths[4]], request: "整理接口版本及其适用条件" };
  const limited = await call(clients[0], "learning_knowledge_collect", { projectPaths: [paths[0]], excludePaths: [paths[4]] });
  assert.deepEqual(limited.sources.items.map(item => item.path), [paths[0]]);
  const collected = await call(clients[0], "learning_knowledge_collect", scope);
  assert.equal(collected.sources.total, 5);
  assert.ok(collected.template.markdown.includes("knowledge-organize-v1"));
  const notes = await Promise.all(paths.map(path => call(clients[0], "learning_read", { path })));
  // learning_read is paginated: the long source is explicitly read to its end.
  for (const note of notes) {
    while (note.nextOffset !== null) {
      const page = await call(clients[0], "learning_read", { path: note.path, offset: note.nextOffset });
      assert.equal(page.version, note.version);
      note.content += page.content; note.nextOffset = page.nextOffset;
    }
  }
  const evidence = notes.map(note => ({ path: note.path, start: 0, end: Math.min(24, note.content.length), quote: note.content.slice(0, 24) }));
  const draft = { template: "knowledge-organize-v1", request: scope.request, title: "接口版本", summary: "公共与实验接口分别保留适用条件，文档版本另列。",
    sources: notes.map(note => ({ path: note.path, version: note.version, total: note.content.length, ranges: [{ start: 0, end: note.content.length }] })),
    groups: [{ title: "接口", items: [
      { id: "public-version", title: "公共接口版本", content: "公共接口需保持兼容。", evidence: [evidence[0], evidence[2]] },
      { id: "experimental-version", title: "实验接口版本", content: "内部实验不承诺兼容，不能直接套用公共接口规则。", evidence: [evidence[1], evidence[3]] },
    ] }, { title: "同名概念", items: [{ id: "document-version", title: "文档修订版本", content: "文档修订与接口兼容是不同概念。", evidence: [evidence[3], evidence[4]] }] }],
    relations: [{ from: "public-version", to: "experimental-version", type: "冲突", origin: "inferred", reason: "表面冲突，适用条件不同。", evidence: evidence.slice(0, 4) }], unknowns: ["实际模型归纳质量待验。"] };
  const targetPath = `Wiki/接口 总览 ${suffix}.md`;
  const pending = await call(clients[0], "learning_plan_knowledge", { targetPath, draft });
  const id = { planId: pending.planId, revision: pending.revision };
  const instance = (await call(clients[0], "learning_status")).instanceId;
  await Promise.all(clients.splice(0).map(client => client.close()));
  stop();
  const restarted = await connect();
  assert.notEqual((await call(restarted, "learning_status")).instanceId, instance);
  const resumed = await call(restarted, "learning_preview", id);
  assert.equal(resumed.plan.knowledge.sources.length, 5);
  assert.equal((await call(restarted, "learning_request_confirmation", id)).status, "completed");
  assert.equal((await call(restarted, "learning_request_confirmation", id)).status, "completed");
  assert.equal(message, "");
  const savedTopic = await call(restarted, "learning_read", { path: targetPath });
  assert.equal(savedTopic.content, resumed.plan.after);
  assert.equal((await call(restarted, "learning_knowledge_collect", { ...scope, topicPath: targetPath })).reuse.state, "reusable");
  const extraPath = `Inbox/新增材料 ${suffix}.md`;
  await writeFile(join(config.vaultRoot, extraPath), "# 新增材料\n新的适用条件需实际阅读。\n");
  const expanded = await call(restarted, "learning_knowledge_collect", { ...scope, topicPath: targetPath, sourcePaths: [...scope.sourcePaths, extraPath] });
  assert.equal(expanded.reuse.state, "update-needed");
  assert.equal(expanded.reuse.counts.reusable, 5);
  assert.equal(expanded.sources.items.find(item => item.path === extraPath).processing.state, "unprocessed");
  const graph = await call(restarted, "learning_knowledge_query", { topicPath: targetPath });
  assert.equal(graph.organized.items.total, 3); assert.equal(graph.organized.relations.total, 1);
  for (const view of ["mindmap", "document"]) assert.deepEqual((await call(restarted, "learning_knowledge_query", { topicPath: targetPath, version: graph.topic.version, view })).organized, graph.organized);
  const topic = (await call(restarted, "learning_manager_probe", { view: "topic", path: targetPath })).topic;
  assert.equal(topic.version, graph.topic.version);
  assert.equal(decodeURIComponent(topic.openUri.split("?path=")[1]), join(config.vaultRoot, targetPath));
  assert.ok(!JSON.stringify(topic).includes("长文背景。".repeat(100)), "Topic projections must not include the long source body");
  const manual = savedTopic.content + "\n人工附录，更新和恢复均须保留。\n";
  await writeFile(join(config.vaultRoot, targetPath), manual);
  const current = await call(restarted, "learning_read", { path: targetPath });
  const updatedDraft = structuredClone(draft);
  updatedDraft.groups.push({ title: "补充", items: [{ id: "conditions", title: "适用条件", content: "接口规则需注明条件。", evidence: [evidence[4]] }] });
  const update = await call(restarted, "learning_plan_knowledge", { targetPath, targetVersion: current.version, draft: updatedDraft });
  assert.equal((await call(restarted, "learning_request_confirmation", { planId: update.planId, revision: update.revision })).status, "completed");
  const afterUpdate = await readFile(join(config.vaultRoot, targetPath), "utf8");
  assert.ok(afterUpdate.includes("人工附录")); assert.ok(afterUpdate.includes("^conditions"));
  await call(restarted, "learning_preview_restore", { operationId: update.planId });
  assert.equal((await call(restarted, "learning_request_restore", { operationId: update.planId, authorization: "user-confirmed" })).status, "completed");
  assert.equal(await readFile(join(config.vaultRoot, targetPath), "utf8"), manual);
  const stale = await call(restarted, "learning_plan_knowledge", { targetPath: `Wiki/过期 ${suffix}.md`, draft });
  await writeFile(join(config.vaultRoot, paths[0]), texts[0] + "外部修改。\n");
  await assert.rejects(call(restarted, "learning_request_confirmation", { planId: stale.planId, revision: stale.revision }), /source changed/);
  await unlink(join(config.vaultRoot, paths[1]));
  const changed = await call(restarted, "learning_knowledge_collect", { ...scope, topicPath: targetPath });
  assert.equal(changed.reuse.state, "update-needed");
  assert.equal(changed.sources.items.find(item => item.path === paths[0]).processing.state, "changed");
  assert.ok(changed.unavailable.items.some(item => item.path === paths[1]));
  assert.equal((await call(restarted, "learning_read", { path: "Wiki/版本检查.md" })).content, original.content);
  // Exercise the installed PDF.js worker and font resources, without a dev dependency.
  const { getDocument } = await load("pdfjs-dist/legacy/build/pdf.mjs");
  const { dirname } = await import("node:path");
  const pdfRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream = "BT /F1 12 Tf 10 100 Td (Synthetic install PDF) Tj ET";
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const task = getDocument({ data: new Uint8Array(Buffer.from(pdf)), isEvalSupported: false, useWorkerFetch: false, useSystemFonts: false,
    standardFontDataUrl: join(pdfRoot, "standard_fonts").replaceAll("\\", "/") + "/" });
  try {
    const doc = await task.promise;
    const text = await (await doc.getPage(1)).getTextContent();
    assert.ok(text.items.some(item => item.str === "Synthetic install PDF"));
  } finally { await task.destroy(); }
  process.stdout.write("PASS: production-only installation, HTML/notices/template resources, two clients/one writer, ordinary save/idempotence, five-source scope/long read, persisted plan after restart, knowledge save/reuse/three view projections/Obsidian URI, manual append/update/restore, changed/missing sources, old note readability, PDF worker/fonts, setup-only routines. Synthetic drafts; actual host UI, Obsidian launch, model quality and token usage are not verified.\n");
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  stop();
}
