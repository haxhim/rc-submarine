import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("firmware preserves the bench-proven motor and camera profile", async () => {
  const pins = await readFile("esp-materials/include/pins.h", "utf8");
  const firmware = await readFile("esp-materials/src/main.cpp", "utf8");

  assert.match(pins, /LEFT_ESC_PIN = 15/);
  assert.match(pins, /RIGHT_ESC_PIN = 14/);
  assert.match(pins, /FRONT_BALLAST_PIN = 12/);
  assert.match(pins, /REAR_BALLAST_PIN = 13/);
  assert.match(firmware, /leftEsc\.attach\(LEFT_ESC_PIN, 1000, 2000\)/);
  assert.match(firmware, /rightEsc\.attach\(RIGHT_ESC_PIN, 1000, 2000\)/);
  assert.match(firmware, /FRAMESIZE_QVGA/);
  assert.match(firmware, /CAMERA_GRAB_LATEST/);
  assert.match(firmware, /const size_t chunk = min\(static_cast<size_t>\(1460\)/);
  assert.match(firmware, /xTaskCreatePinnedToCore\(cameraStreamTask/);
  assert.match(firmware, /ESP32PWM::allocateTimer\(1\)/);
});
