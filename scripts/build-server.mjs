// Bundles the MCP server entry points with esbuild (no bun required).
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  logLevel: "info",
};

await build({ ...common, entryPoints: ["server.ts"], outfile: "dist/server.js" });
await build({
  ...common,
  entryPoints: ["main.ts"],
  outfile: "dist/index.js",
  external: ["./server.js"],
  banner: { js: "#!/usr/bin/env node" },
});
