import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import "./build-manager.mjs";

if (process.platform === "win32") {
  const compiler = join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const compiled = spawnSync(compiler, ["/nologo", "/target:winexe", "/utf8output", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
    "/reference:System.Web.Extensions.dll", `/win32manifest:${join(process.cwd(), "src", "knowledge-setup.manifest")}`,
    `/out:${join(process.cwd(), "dist", "knowledge-setup.exe")}`, join(process.cwd(), "src", "knowledge-setup-window.cs")], { stdio: "inherit", windowsHide: true });
  if (compiled.error || compiled.status !== 0) throw compiled.error ?? new Error("Windows setup compilation failed");
}

await build({
  entryPoints: ["src/knowledge-launcher.ts"],
  outfile: "dist/knowledge-launcher.js",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "es2022",
});
await build({
  entryPoints: ["src/knowledge-setup.ts"],
  outfile: "dist/knowledge-setup.js",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "es2022",
});
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "es2022",
});
await build({
  entryPoints: ["src/client.tsx"],
  outfile: "dist/client.js",
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: ["react", "react/jsx-runtime"],
  loader: { ".css": "text" },
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-learning-os", factory: (require) => { const module = { exports: {} }; const exports = module.exports;' },
  footer: { js: "return module.exports; } });" },
});
