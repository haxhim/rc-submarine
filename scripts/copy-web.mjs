import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "web/dist");
const espData = resolve(root, "esp-materials/data");
const espStatic = resolve(root, "esp-materials/static");
const androidAssets = resolve(root, "android/app/src/main/assets/controller");

await mkdir(dist, { recursive: true });
await cp(resolve(root, "web/index.html"), resolve(dist, "index.html"));
await cp(resolve(root, "web/styles.css"), resolve(dist, "styles.css"));
await cp(resolve(root, "web/visibility.css"), resolve(dist, "visibility.css"));
await cp(resolve(root, "web/landscape.css"), resolve(dist, "landscape.css"));
await rm(androidAssets, { recursive: true, force: true });
await mkdir(androidAssets, { recursive: true });
await cp(dist, androidAssets, { recursive: true });
await rm(espData, { recursive: true, force: true });
await mkdir(espData, { recursive: true });
await cp(espStatic, espData, { recursive: true });
console.log("Web controller bundled into Android; lightweight diagnostics copied to ESP materials.");
