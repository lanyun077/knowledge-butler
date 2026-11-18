import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute, join } from "node:path";

// Host discovery only: no threads, model turns, approvals or Vault writes.
const [marketplaceRoot, executable = "codex"] = process.argv.slice(2);
if (!marketplaceRoot || !isAbsolute(marketplaceRoot) || process.argv.length > 4) {
  throw new Error("Pass the absolute marketplace root and optionally the Codex executable");
}
const child = spawn(executable, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
const requests = new Map();
let serial = 0;
const rejectRequests = error => { for (const pending of requests.values()) pending.reject(error); requests.clear(); };
child.on("error", rejectRequests);
child.on("exit", () => rejectRequests(new Error("Codex app-server exited before verification completed")));
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const pending = requests.get(message.id);
  if (!pending) return;
  requests.delete(message.id);
  if (message.error) pending.reject(new Error(message.error.message));
  else pending.resolve(message.result);
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 45000);
  requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
try {
  await rpc("initialize", { clientInfo: { name: "learning_os_plugin_check", title: "Read-only plugin check", version: "1" },
    capabilities: { experimentalApi: true, requestAttestation: false } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const { plugin } = await rpc("plugin/read", { marketplacePath: join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), pluginName: "learning-os-trial" });
  assert.equal(plugin.summary.installed, true, "Plugin is not installed");
  assert.equal(plugin.summary.enabled, true, "Plugin is not enabled");
  assert.ok(plugin.mcpServers.includes("knowledge"), "Codex did not discover the plugin's knowledge MCP declaration");
  const servers = [];
  let cursor;
  do {
    const page = await rpc("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) });
    servers.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  const server = servers.find(item => item.pluginId === plugin.summary.id && item.name === "knowledge");
  assert.ok(server, "Codex did not load the plugin's knowledge MCP server");
  assert.equal(server.toolsError, null, "Codex tool discovery failed");
  for (const name of ["learning_status", "learning_manage", "learning_open_manager", "learning_manager_probe", "learning_manager_open_note", "learning_read", "learning_plan_business", "learning_request_confirmation", "learning_knowledge_collect", "learning_knowledge_query", "learning_plan_knowledge"]) {
    assert.ok(Object.hasOwn(server.tools, name), `Codex did not load ${name}`);
  }
  process.stdout.write(JSON.stringify({ status: "passed", pluginId: plugin.summary.id, version: plugin.summary.localVersion,
    server: server.name, toolCount: Object.keys(server.tools).length, skills: plugin.skills.map(skill => skill.name),
    scope: "Codex host discovery; no model turn or human UI verification" }, null, 2) + "\n");
} finally {
  lines.close();
  child.kill();
}
