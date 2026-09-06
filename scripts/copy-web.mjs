import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "web/dist");
const firmwareData = resolve(root, "firmware/data");

await mkdir(dist, { recursive: true });
await cp(resolve(root, "web/index.html"), resolve(dist, "index.html"));
await cp(resolve(root, "web/styles.css"), resolve(dist, "styles.css"));
await cp(resolve(root, "web/visibility.css"), resolve(dist, "visibility.css"));
await cp(resolve(root, "web/landscape.css"), resolve(dist, "landscape.css"));
await rm(firmwareData, { recursive: true, force: true });
await mkdir(firmwareData, { recursive: true });
await cp(dist, firmwareData, { recursive: true });
console.log("Web controller built and copied into firmware/data.");
