import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "android/app/build/outputs/apk/debug/app-debug.apk");
const releases = resolve(root, "releases");
await mkdir(releases, { recursive: true });
await copyFile(source, resolve(releases, "SubmarineRC-v1.2.1.apk"));
console.log("Created releases/SubmarineRC-v1.2.1.apk");
