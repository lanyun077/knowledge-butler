import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFolders } from "../src/business-api";
import { loadKnowledgeConfig } from "../src/knowledge-config";
import { startKnowledgeService } from "../src/knowledge-service";
import { sharedVault } from "../src/knowledge-client";
import type { ProjectBinding } from "../src/knowledge-projects";

export async function testSharedVault(root: string, folders = defaultFolders, projects: ProjectBinding[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-test-connection-"));
  const connectionFile = join(directory, "connection.json");
  await writeFile(connectionFile, JSON.stringify({ schemaVersion: 1, vaultRoot: root, folders, projects, token: randomBytes(32).toString("hex") }));
  const config = await loadKnowledgeConfig(connectionFile);
  const service = await startKnowledgeService(config);
  return { config, connectionFile, service, client: sharedVault(connectionFile, { root, folders }),
    async dispose() { await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); } };
}
