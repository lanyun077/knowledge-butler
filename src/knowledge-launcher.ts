import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKnowledgeConfig, type KnowledgeConfig } from "./knowledge-config";
import { startKnowledgeService } from "./knowledge-service";
import { knowledgeStdio } from "./knowledge-stdio";
import { serviceStatus } from "./knowledge-service-status";
export { serviceStatus } from "./knowledge-service-status";

export async function ensureKnowledgeService(config: KnowledgeConfig, configPath: string, launcherPath = fileURLToPath(import.meta.url)) {
  let shouldLaunch = true;
  try { return await serviceStatus(config); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "SERVICE_INITIALIZING") shouldLaunch = false;
    else if (!(error instanceof TypeError && error.cause && (error.cause as NodeJS.ErrnoException).code === "ECONNREFUSED")) throw error;
  }
  let launchError: Error | undefined;
  if (shouldLaunch) {
    const child = spawn(process.execPath, [launcherPath, "serve", "--config", resolve(configPath)], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.on("error", error => { launchError = error; });
    child.unref();
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    await new Promise(resolve => setTimeout(resolve, 50));
    try { return await serviceStatus(config); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "SERVICE_INITIALIZING"
        && !(error instanceof TypeError && error.cause && (error.cause as NodeJS.ErrnoException).code === "ECONNREFUSED")) throw error;
    }
  }
  throw new Error("Knowledge service did not start; check port ownership and run serve explicitly for diagnostics");
}

async function main() {
  const [command, flag, configPath, ...rest] = process.argv.slice(2);
  if (flag !== "--config" || !configPath || rest.length || !["stdio", "serve", "status", "stop"].includes(command)) {
    throw new Error("Usage: node dist/knowledge-launcher.js <stdio|serve|status|stop> --config <isolated-config.json>");
  }
  const config = await loadKnowledgeConfig(configPath);
  if (command === "serve") {
    const service = await startKnowledgeService(config);
    process.once("SIGINT", () => { void service.close(); });
    process.once("SIGTERM", () => { void service.close(); });
    await service.done;
  } else if (command === "stdio") {
    await ensureKnowledgeService(config, configPath);
    await knowledgeStdio(config);
  } else if (command === "status") {
    process.stdout.write(`${JSON.stringify(await serviceStatus(config))}\n`);
  } else {
    await serviceStatus(config);
    const response = await fetch(`${config.url}/stop`, { method: "POST", headers: { Authorization: `Bearer ${config.token}` } });
    if (!response.ok) throw new Error(`Knowledge service stop failed: HTTP ${response.status}`);
    process.stdout.write("Knowledge service stopped\n");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
