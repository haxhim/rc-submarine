import assert from "node:assert/strict";
import test from "node:test";
import { clamp, mixDrive, normalizedToPulse, safeJson, validPulse } from "../web/dist/control.js";

test("clamp rejects values outside the control envelope", () => {
  assert.equal(clamp(-2), -1); assert.equal(clamp(0.25), 0.25); assert.equal(clamp(2), 1);
});

test("differential mixing applies yaw and throttle limit", () => {
  assert.deepEqual(mixDrive(1, 0, 0.6), { left: 0.6, right: 0.6 });
  assert.deepEqual(mixDrive(0, 1, 0.5), { left: 0.5, right: -0.5 });
  assert.deepEqual(mixDrive(1, 1, 1), { left: 1, right: 0 });
});

test("normalized PWM conversion remains inside calibrated pulses", () => {
  assert.equal(normalizedToPulse(-1, 1100, 1500, 1900), 1100);
  assert.equal(normalizedToPulse(0, 1100, 1500, 1900), 1500);
  assert.equal(normalizedToPulse(1, 1100, 1500, 1900), 1900);
});

test("calibration pulse validation enforces safe bounds", () => {
  assert.equal(validPulse(800), true); assert.equal(validPulse(2200), true);
  assert.equal(validPulse(799), false); assert.equal(validPulse(2201), false);
});

test("protocol parser accepts objects and rejects invalid packets", () => {
  assert.deepEqual(safeJson('{"v":1,"type":"heartbeat"}'), { v: 1, type: "heartbeat" });
  assert.equal(safeJson("[]"), null); assert.equal(safeJson("bad-json"), null);
});
