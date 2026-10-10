import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/sidecar.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  legalComments: "external",
  // The SDK and some deps use require(); give ESM bundles a working require.
  banner: {
    js: "import { createRequire as __forgeCreateRequire } from 'node:module'; const require = __forgeCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
