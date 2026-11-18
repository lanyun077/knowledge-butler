import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const plugin = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
if (process.platform !== "win32") throw new Error("Windows release packaging requires PowerShell Compress-Archive");
if (pkg.version !== plugin.version || pkg.version !== lock.version || pkg.version !== lock.packages[""].version) throw new Error("Release versions differ");
const output = resolve(process.argv[2] ?? join(root, "release"));
await mkdir(output, { recursive: true });
await mkdir(join(root, "node_modules", ".cache"), { recursive: true });
const staging = await mkdtemp(join(root, "node_modules", ".cache", "release-"));
const name = `knowledge-butler-${pkg.version}-windows`;
const bundle = join(staging, name);
await mkdir(bundle);
// Explicit distributable files: never copy local Vaults, connection files or caches.
for (const path of ["package.json", "package-lock.json", "plugin.json", "dist", "skills", "third-party", "LICENSE", "THIRD-PARTY.md", "README.md", "INSTALL.md", "CHANGELOG.md", "RELEASE-VALIDATION.md", "KNOWLEDGE-GUIDE.md", "docs/GETTING-STARTED.md", "docs/images", "compatibility.md"]) {
  await cp(join(root, path), join(bundle, path), { recursive: true });
}
await mkdir(join(bundle, "scripts"));
for (const path of ["prepare-codex-trial.mjs", "prepare-knowledge-demo.mjs", "verify-codex-trial.mjs", "verify-codex-plugin.mjs"]) {
  await cp(join(root, "scripts", path), join(bundle, "scripts", path));
}
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || result.stdout);
  return result.stdout;
};
const zip = `${name}.zip`;
run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -LiteralPath $env:KB_RELEASE_BUNDLE -DestinationPath $env:KB_RELEASE_ZIP -Force"], {
  env: { ...process.env, KB_RELEASE_BUNDLE: bundle, KB_RELEASE_ZIP: join(output, zip) },
});
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const packed = JSON.parse(run(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", output]))[0];
const sums = await Promise.all([zip, packed.filename].map(async file => `${createHash("sha256").update(await readFile(join(output, file))).digest("hex")}  ${file}`));
await writeFile(join(output, "SHA256SUMS.txt"), sums.join("\n") + "\n");
process.stdout.write(`Release files: ${output}\n${sums.join("\n")}\n`);
