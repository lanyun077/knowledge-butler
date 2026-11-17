import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { defaultFolderMap } from "./vault";
import { normalizeProjects, projectBindingSchema } from "./knowledge-projects";

const schema = z.object({
  schemaVersion: z.literal(1),
  vaultRoot: z.string().refine(isAbsolute, "Vault root must be absolute"),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  folders: z.object({ inbox: z.string(), knowledge: z.string(), daily: z.string(), projects: z.string(), learning: z.string() }).strict().default(defaultFolderMap),
  projects: z.array(projectBindingSchema).default([]),
}).strict();
export type KnowledgeConfig = z.infer<typeof schema> & { vaultId: string; port: number; url: string };

export async function loadKnowledgeConfig(path: string): Promise<KnowledgeConfig> {
  const value = schema.parse(JSON.parse(await readFile(path, "utf8")));
  const vaultRoot = await realpath(value.vaultRoot);
  const canonical = process.platform === "win32" ? vaultRoot.toLowerCase() : vaultRoot;
  const vaultId = createHash("sha256").update(canonical).digest("hex");
  // Binding this stable loopback port is the OS-level exclusive ownership operation.
  // A hash collision fails closed at the authenticated vaultId handshake.
  const port = 20000 + (parseInt(vaultId.slice(0, 8), 16) % 30000);
  return { ...value, projects: await normalizeProjects(value.projects), vaultRoot, vaultId, port, url: `http://127.0.0.1:${port}` };
}
