import type { KnowledgeConfig } from "./knowledge-config";
import { projectsFingerprint } from "./knowledge-projects";

export async function serviceStatus(config: KnowledgeConfig) {
  const response = await fetch(`${config.url}/status`, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1000) });
  if (!response.ok) {
    const error = new Error(`Knowledge service handshake failed: HTTP ${response.status}`) as NodeJS.ErrnoException;
    if (response.status === 503) error.code = "SERVICE_INITIALIZING";
    throw error;
  }
  const status = await response.json() as { schemaVersion: number; vaultId: string; instanceId: string; stopping: boolean; folders?: KnowledgeConfig["folders"]; projectsFingerprint?: string };
  if (status.schemaVersion !== 2 || status.vaultId !== config.vaultId || status.stopping || status.projectsFingerprint !== projectsFingerprint(config.projects)
    || !status.folders || Object.keys(config.folders).some(key => status.folders![key as keyof typeof config.folders] !== config.folders[key as keyof typeof config.folders])) throw new Error("Knowledge service identity differs or is stopping");
  return status;
}
