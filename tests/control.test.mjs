import assert from "node:assert/strict";
import test from "node:test";
import {
  ballastAngleToPulse,
  clamp,
  directMotorLevels,
  effectiveBallastAngles,
  mixDrive,
  normalizedToPulse,
  safeJson,
  validPulse,
} from "../web/dist/control.js";

test("clamp rejects values outside the control envelope", () => {
  assert.equal(clamp(-2), -1); assert.equal(clamp(0.25), 0.25); assert.equal(clamp(2), 1);
});

test("differential mixing applies yaw and throttle limit", () => {
  assert.deepEqual(mixDrive(1, 0, 0.6), { left: 0.6, right: 0.6 });
  assert.deepEqual(mixDrive(0, 1, 0.5), { left: 0.5, right: -0.5 });
  assert.deepEqual(mixDrive(1, 1, 1), { left: 1, right: 0 });
});

test("direct motor levels preserve independent steering and apply the throttle limit", () => {
  assert.deepEqual(directMotorLevels(1, 1, 0.6), { left: 0.6, right: 0.6 });
  assert.deepEqual(directMotorLevels(0.4, 0.8, 0.5), { left: 0.2, right: 0.4 });
  assert.deepEqual(directMotorLevels(-2, 2, 1), { left: -1, right: 1 });
});

test("ballast master and trims clamp to the physical 0 to 180 degree range", () => {
  assert.deepEqual(effectiveBallastAngles(90, -10, 15), { front: 80, rear: 105 });
  assert.deepEqual(effectiveBallastAngles(175, 20, -200), { front: 180, rear: 0 });
});

test("ballast angle maps dive at 0 degrees and surface at 180 degrees", () => {
  assert.equal(ballastAngleToPulse(0, 1000, 2000), 2000);
  assert.equal(ballastAngleToPulse(90, 1000, 2000), 1500);
  assert.equal(ballastAngleToPulse(180, 1000, 2000), 1000);
  assert.equal(ballastAngleToPulse(0, 1000, 2000, true), 1000);
  assert.equal(ballastAngleToPulse(180, 1000, 2000, true), 2000);
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
