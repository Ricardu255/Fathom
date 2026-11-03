import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = dirname(scriptDir);
const repoRoot = dirname(dirname(desktopDir));
const resources = join(desktopDir, "resources");

await rm(resources, { force: true, recursive: true });
await mkdir(resources, { recursive: true });

await build({
  banner: {
    js: "import { createRequire as __fathomCreateRequire } from 'node:module'; const require = __fathomCreateRequire(import.meta.url);",
  },
  bundle: true,
  entryPoints: [join(repoRoot, "apps", "daemon", "src", "bootstrap.ts")],
  format: "esm",
  logLevel: "info",
  outfile: join(resources, "daemon.mjs"),
  platform: "node",
  sourcemap: false,
  target: "node22",
});

await cp(join(repoRoot, "apps", "web", "dist"), join(resources, "web"), {
  recursive: true,
});
console.log("desktop assets ready");
