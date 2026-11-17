import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { KnowledgeConfig } from "./knowledge-config";

/** Protocol-only bridge: no writer or plan state. */
export async function knowledgeStdio(config: KnowledgeConfig) {
  const downstream = new Server({ name: "dsh-knowledge-stdio", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
  const upstream = new Client({ name: "dsh-knowledge-bridge", version: "0.1.0" }, { capabilities: {} });
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // The actual host must initialize first; do not invent its UI or approval capabilities.
  downstream.oninitialized = () => {
    const capabilities = downstream.getClientCapabilities();
    const ui = capabilities?.extensions?.["io.modelcontextprotocol/ui"];
    if (ui) upstream.registerCapabilities({ extensions: { "io.modelcontextprotocol/ui": ui } });
    if (capabilities?.elicitation && (capabilities.elicitation.form || Object.keys(capabilities.elicitation).length === 0)) {
      upstream.registerCapabilities({ elicitation: { form: {} } });
      upstream.setRequestHandler(ElicitRequestSchema, (request, extra) => downstream.elicitInput(request.params, { signal: extra.signal, timeout: 300000 }));
    }
    void upstream.connect(new StreamableHTTPClientTransport(new URL(`${config.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    })).then(resolveReady, rejectReady);
  };
  downstream.setRequestHandler(ListToolsRequestSchema, async (request, extra) => { await ready; return upstream.listTools(request.params, { signal: extra.signal }); });
  downstream.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => { await ready; return upstream.listResources(request.params, { signal: extra.signal }); });
  downstream.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => { await ready; return upstream.listResourceTemplates(request.params, { signal: extra.signal }); });
  downstream.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => { await ready; return upstream.readResource(request.params, { signal: extra.signal }); });
  downstream.setRequestHandler(CallToolRequestSchema, async (request, extra) => { await ready; return upstream.callTool(request.params, undefined, { signal: extra.signal, timeout: 300000 }); });
  const close = async () => { await upstream.close(); await downstream.close(); };
  downstream.onclose = () => { rejectReady(new Error("MCP host disconnected before upstream initialization")); void upstream.close(); };
  await downstream.connect(new StdioServerTransport());
  try { await ready; }
  catch (error) { await close(); throw error; }
  return { close };
}
