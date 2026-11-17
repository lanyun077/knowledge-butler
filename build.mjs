import { build } from "esbuild";
import "./build-manager.mjs";

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
