import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { WebSocket } from "ws";

const port = 3199;
let simulator;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Simulator startup timed out")), 5000);
    child.stdout.on("data", (data) => {
      if (String(data).includes("Submarine RC simulator")) { clearTimeout(timeout); resolve(); }
    });
    child.on("exit", (code) => reject(new Error(`Simulator exited with ${code}`)));
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function command(socket, seq, type, payload = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No acknowledgement for ${type}`)), 2000);
    const listener = (raw) => {
      const packet = JSON.parse(String(raw));
      if (packet.type === "ack" && packet.seq === seq) {
        clearTimeout(timeout);
        socket.off("message", listener);
        resolve(packet);
      }
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ v: 1, type, seq, ts: Date.now(), ...payload }));
  });
}

test("simulator enforces pilot lock, validation and heartbeat failsafe", async (context) => {
  simulator = spawn(process.execPath, ["simulator/server.mjs"], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => simulator.kill("SIGTERM"));
  await waitForServer(simulator);

  const pilot = await connect();
  const monitor = await connect();
  context.after(() => { pilot.close(); monitor.close(); });

  const claim = await command(pilot, 1, "claim");
  assert.equal(claim.ok, true);
  assert.equal(claim.state.pilot, true);

  const denied = await command(monitor, 2, "claim");
  assert.equal(denied.ok, false);
  assert.match(denied.message, /active pilot/i);

  assert.equal((await command(pilot, 3, "arm", { armed: true })).ok, true);
  const motors = await command(pilot, 4, "motors", { left: 1, right: 0.5, limit: 0.6 });
  assert.equal(motors.ok, true);
  assert.equal(motors.state.leftMotor, 0.6);
  assert.equal(motors.state.rightMotor, 0.3);

  const invalidMotors = await command(pilot, 5, "motors", { left: 2, right: 0, limit: 1 });
  assert.equal(invalidMotors.ok, false);

  const ballast = await command(pilot, 6, "ballast_angle", { frontDeg: 0, rearDeg: 180 });
  assert.equal(ballast.ok, true);
  assert.equal(ballast.state.frontBallastDeg, 0);
  assert.equal(ballast.state.rearBallastDeg, 180);

  const invalidBallast = await command(pilot, 7, "ballast_angle", { frontDeg: 181, rearDeg: 90 });
  assert.equal(invalidBallast.ok, false);

  const legacyDrive = await command(pilot, 8, "drive", { surge: 0.5, yaw: 0.1, limit: 1 });
  assert.equal(legacyDrive.ok, true);
  assert.equal(legacyDrive.state.leftMotor, 0.6);
  assert.equal(legacyDrive.state.rightMotor, 0.4);

  const legacyBallast = await command(pilot, 9, "ballast", { front: 0, rear: 1 });
  assert.equal(legacyBallast.ok, true);
  assert.equal(legacyBallast.state.frontBallastDeg, 180);
  assert.equal(legacyBallast.state.rearBallastDeg, 0);

  await new Promise((resolve) => setTimeout(resolve, 1250));
  const status = await fetch(`http://127.0.0.1:${port}/api/status`).then((response) => response.json());
  assert.equal(status.armed, false);
  assert.equal(status.failsafe, true);
  assert.equal(status.frontBallast, 0);
  assert.equal(status.rearBallast, 0);
  assert.equal(status.frontBallastDeg, 180);
  assert.equal(status.rearBallastDeg, 180);
  assert.equal(status.leftMotor, 0);
  assert.equal(status.rightMotor, 0);
  assert.equal("pilot" in status, false);
});
