import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KnowledgeConfig } from "./knowledge-config";
import { KnowledgeCore } from "./knowledge-core";
import { knowledgeMcp } from "./knowledge-mcp";
import { z } from "zod";
import { contextMethods, planMethods, readMethods } from "./knowledge-host";
import { projectsFingerprint } from "./knowledge-projects";

const hostRequest = z.object({
  channel: z.string().uuid(), method: z.enum([...readMethods, ...planMethods, ...contextMethods, "capture", "execute", "restore", "activity", "cancelPlan", "previewPlan", "owns", "listPlans", "status"]),
  args: z.array(z.unknown()).max(5), ticket: z.string().uuid().optional(),
  owner: z.object({ scope: z.string(), sessionId: z.string(), cwd: z.string(), kind: z.enum(["daily", "project", "goal", "inbox", "report"]) }).strict().optional(),
}).strict();

export async function startKnowledgeService(config: KnowledgeConfig) {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }>();
  let core: KnowledgeCore;
  let ready = false;
  let closing: Promise<void> | undefined;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const http = createServer(async (req, res) => {
    const reject = (status: number, message: string) => { res.writeHead(status, { "Content-Type": "text/plain" }); res.end(message); };
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (req.headers.host !== `127.0.0.1:${config.port}` || req.headers.origin !== undefined) return reject(403, "Forbidden host or origin");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reject(401, "Unauthorized");
    if (!ready) return reject(503, "Knowledge service is initializing");
    if (req.url === "/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ schemaVersion: 2, folders: config.folders, projectsFingerprint: projectsFingerprint(config.projects), ...core.status() }));
    }
    if (req.url === "/stop" && req.method === "POST") {
      await core.stop();
      res.end(JSON.stringify({ stopped: true }));
      setImmediate(() => { void close(); });
      return;
    }
    if (req.url === "/host" && req.method === "POST") {
      const abort = new AbortController();
      req.once("aborted", () => abort.abort());
      res.once("close", () => { if (!res.writableEnded) abort.abort(); });
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 14_000_000) throw new Error("Host request exceeds the PDF/text input limit");
          chunks.push(Buffer.from(chunk));
        }
        const request = hostRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const reply = await core.host(request, abort.signal);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, ...reply }));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), code: (error as NodeJS.ErrnoException).code }));
      }
      return;
    }
    if (req.url !== "/mcp") return reject(404, "Not found");
    if (core.status().stopping) return reject(503, "Knowledge service is stopping");
    try {
      const id = req.headers["mcp-session-id"];
      let session = typeof id === "string" ? sessions.get(id) : undefined;
      if (!session) {
        if (id) return reject(404, "Unknown MCP session; reconnect");
        if (req.method !== "POST") return reject(400, "MCP initialization required");
        const mcp = knowledgeMcp(core);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: sessionId => { sessions.set(sessionId, { transport, mcp }); } });
        await mcp.connect(transport);
        const onclose = transport.onclose;
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); onclose?.(); };
        session = { transport, mcp };
      }
      await session.transport.handleRequest(req, res);
      if (!session.transport.sessionId) await session.mcp.close();
    } catch {
      if (!res.headersSent) reject(500, "MCP request failed");
      else res.end();
    }
  });
  // Bind before constructing the writer. A second launcher cannot win this port.
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, "127.0.0.1", () => { http.off("error", reject); resolve(); });
  });
  core = new KnowledgeCore(config.vaultId, config.vaultRoot, config.folders, config.projects);
  try { await core.initialize(); ready = true; }
  catch (error) { await new Promise<void>(resolve => http.close(() => resolve())); throw error; }
  function close() {
    return closing ??= (async () => {
      await core.stop();
      await Promise.allSettled([...sessions.values()].map(session => session.mcp.close()));
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      finish();
    })();
  }
  return { close, done, status: () => core.status() };
}
