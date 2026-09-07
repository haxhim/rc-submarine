import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

test("Android owns the full controller UI while ESP serves only diagnostics", async () => {
  const androidIndex = await readFile("android/app/src/main/assets/controller/index.html", "utf8");
  const androidScript = await stat("android/app/src/main/assets/controller/app.js");
  const espIndex = await readFile("esp-materials/data/index.html", "utf8");
  const activity = await readFile("android/app/src/main/java/my/finalyearproject/submarinerc/MainActivity.java", "utf8");

  assert.match(androidIndex, /\.\/app\.js\?v=/);
  assert.ok(androidScript.size > 20_000, "compiled controller JavaScript must be bundled in the APK assets");
  assert.match(activity, /https:\/\/appassets\.androidplatform\.net\/controller\/index\.html/);
  assert.match(espIndex, /Open the Submarine RC app/);
  assert.ok(Buffer.byteLength(espIndex) < 5_000, "ESP diagnostic page should stay lightweight");
});
