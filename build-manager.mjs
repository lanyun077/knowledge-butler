import { build } from "esbuild";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const stars = await build({ entryPoints: ["src/manager/stars/viewer.js"], bundle: true, write: false, minify: true, metafile: true,
  platform: "browser", format: "iife", target: "es2022", legalComments: "inline" });
const starHtml = (await readFile("src/manager/stars/shell.html", "utf8")).replace("/* APP */", () => stars.outputFiles[0].text.replace(/<\/script/gi, "<\\/script"));
const bundle = await build({ entryPoints: ["src/manager/app.tsx"], bundle: true, write: false,
  platform: "browser", format: "iife", target: "es2022", jsx: "automatic", minify: true, metafile: true,
  define: { "process.env.NODE_ENV": '"production"', __STAR_MAP_HTML__: JSON.stringify(starHtml) }, loader: { ".css": "text" } });
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await mkdir("dist", { recursive: true });
await writeFile("dist/knowledge-manager.html", `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>知识管家 · 全库管理</title></head><body><div id="root"></div><script>${script}</script></body></html>`);
// Include licenses for the browser dependencies embedded in the standalone HTML.
const roots = new Set();
const inputs = [bundle, stars].flatMap(result => Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([input]) => input)));
for (const input of inputs.filter(input => input.includes("node_modules/"))) {
  let root = dirname(resolve(input));
  while (true) {
    if ((await readdir(root)).includes("package.json")) {
      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (pkg.name && pkg.version) break;
    }
    root = dirname(root);
  }
  roots.add(root);
}
const notices = await Promise.all([...roots].sort().map(async root => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const files = (await readdir(root)).filter(name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name)).sort();
  const texts = await Promise.all(files.map(async name => `${name}\n${await readFile(join(root, name), "utf8")}`));
  if (pkg.name === "format" && pkg.version === "0.2.2") texts.push(await readFile("third-party/format-0.2.2.LICENSE.txt", "utf8"));
  if (!texts.length) throw new Error(`Missing bundled license text: ${pkg.name}`);
  return `${pkg.name}@${pkg.version} (${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses)})\n${texts.join("\n\n")}`;
}));
await writeFile("dist/knowledge-manager.NOTICES.txt", `Third-party notices for knowledge-manager.html\nGenerated from bundled package inputs; runtime dependencies retain their own notices in node_modules.\n\n${notices.join("\n\n---\n\n")}\n`);
