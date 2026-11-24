import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Single source of truth for the app version; stamped into dist/sw.js on every build.
const { version } = JSON.parse(readFileSync("./package.json", "utf8"));

const SW_VERSION_PLACEHOLDER = "__APP_VERSION__";
const SW_ASSETS_PLACEHOLDER = '"__PRECACHE_ASSETS__"';

/** Writes the app version and hashed asset list into dist/sw.js so every release caches cleanly offline. */
function serviceWorkerVersion() {
  let outDir;
  return {
    name: "service-worker-version",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      handler() {
        const swFile = resolve(outDir, "sw.js");
        const assetsDir = resolve(outDir, "assets");
        let assetUrls = [];
        try {
          assetUrls = readdirSync(assetsDir).map((name) => `./assets/${name}`);
        } catch {
          assetUrls = [];
        }
        let source = readFileSync(swFile, "utf8");
        if (!source.includes(SW_VERSION_PLACEHOLDER)) {
          throw new Error(`sw.js does not contain ${SW_VERSION_PLACEHOLDER}`);
        }
        source = source.replaceAll(SW_VERSION_PLACEHOLDER, version);
        source = source.replace(
          SW_ASSETS_PLACEHOLDER,
          assetUrls.map((u) => JSON.stringify(u)).join(",\n  "),
        );
        writeFileSync(swFile, source);
      },
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [serviceWorkerVersion()],
  // Relative base so the build works on GitHub Pages under any repo sub-path.
  base: "./",
  // Expose the dev server on the LAN so it can be tested from a phone.
  server: { host: true },
});
