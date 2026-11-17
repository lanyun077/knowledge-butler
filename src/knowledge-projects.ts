import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const projectBindingSchema = z.object({
  directory: z.string().refine(isAbsolute, "Project directory must be absolute"),
  projectPath: z.string().min(1),
  sourceRoot: z.string().refine(isAbsolute, "Source root must be absolute").optional(),
}).strict();
export type ProjectBinding = z.infer<typeof projectBindingSchema>;
export interface ProjectContext { bound: boolean; directory?: string; projectPath?: string; fileSubmission: boolean }
const canonical = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export async function normalizeProjects(projects: ProjectBinding[]): Promise<ProjectBinding[]> {
  const seen = new Set<string>();
  const normalized: ProjectBinding[] = [];
  for (const project of projects) {
    const directory = await realpath(project.directory);
    if (!(await lstat(directory)).isDirectory()) throw new Error("Project directory is not a directory");
    if (seen.has(canonical(directory))) throw new Error("Duplicate project directory binding");
    seen.add(canonical(directory));
    const sourceRoot = project.sourceRoot ? await realpath(project.sourceRoot) : undefined;
    if (sourceRoot && !(await lstat(sourceRoot)).isDirectory()) throw new Error("Project source root is not a directory");
    normalized.push({ directory, projectPath: project.projectPath, ...(sourceRoot ? { sourceRoot } : {}) });
  }
  return normalized.sort((a, b) => canonical(a.directory).localeCompare(canonical(b.directory)));
}

export const projectsFingerprint = (projects: ProjectBinding[]) => createHash("sha256").update(JSON.stringify(projects)).digest("hex");
export function projectBinding(projects: ProjectBinding[], directory?: string): ProjectBinding | undefined {
  // A model-supplied directory is only a lookup hint; never resolve/read it on disk.
  return directory && isAbsolute(directory) ? projects.find(item => canonical(item.directory) === canonical(directory)) : undefined;
}
export function projectContext(projects: ProjectBinding[], directory?: string): ProjectContext {
  const project = projectBinding(projects, directory);
  return project ? { bound: true, directory: project.directory, projectPath: project.projectPath, fileSubmission: !!project.sourceRoot }
    : { bound: false, fileSubmission: false };
}

export async function readProjectHandoff(project: ProjectBinding | undefined, path: string, signal?: AbortSignal): Promise<string> {
  const bytes = await readProjectSource(project, path, "markdown", signal);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Only one explicitly named source under the trusted root; never enumerate or follow links. */
export async function readProjectSource(project: ProjectBinding | undefined, path: string, kind: "markdown" | "pdf", signal?: AbortSignal): Promise<Buffer> {
  if (!project?.sourceRoot) throw new Error("Configure a trusted project sourceRoot before submitting a file; pasted text remains available");
  const parts = path.split("/");
  if (!path || isAbsolute(path) || path.includes("\\") || !(kind === "pdf" ? /\.pdf$/i : /\.md$/i).test(path)
    || parts.some(part => !part || part.startsWith(".") || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw new Error("Unsafe source path; specify one relative Markdown or PDF file of the requested kind");
  const limit = kind === "pdf" ? 5_000_000 : 2_000_000;
  let current = project.sourceRoot;
  if (canonical(await realpath(current)) !== canonical(current)) throw new Error("Project source root changed");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error("Handoff path contains a link or unsupported entry");
    if (index === parts.length - 1 && stat.size > limit) throw new Error(`Source exceeds ${limit} bytes`);
  }
  const bytes = await readFile(current, { signal });
  if (bytes.length > limit) throw new Error(`Source exceeds ${limit} bytes`);
  return bytes;
}
