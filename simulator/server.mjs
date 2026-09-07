import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web", "dist");
const port = Number(process.env.PORT || 3000);
const startedAt = Date.now();

const calibration = {
  escMin: 1100, escNeutral: 1500, escMax: 1900,
  frontSurface: 1000, frontDive: 2000,
  rearSurface: 1000, rearDive: 2000,
  invertLeft: false, invertRight: false,
  invertFront: false, invertRear: false,
};

const state = {
  calibrated: true, armed: false, failsafe: false,
  rssi: -48, uptimeMs: 0, clients: 0, firmware: "simulator-1.2.0",
  light: 0, frontBallast: 0, rearBallast: 0,
  frontBallastDeg: 180, rearBallastDeg: 180,
  frameSize: "VGA", jpegQuality: 12, failsafeMs: 1000,
  streamFps: 6.25,
  leftMotor: 0, rightMotor: 0,
};

let pilot = null;
let lastPilotHeartbeat = 0;
let captureJpeg;

async function loadCapture() {
  try {
    captureJpeg = await readFile(join(here, "camera.jpg"));
  } catch {
    captureJpeg = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=", "base64");
  }
}

function publicState(forSocket = null) {
  state.uptimeMs = Date.now() - startedAt;
  const wobble = Math.round(Math.sin(state.uptimeMs / 5000) * 5);
  return {
    calibrated: state.calibrated, armed: state.armed,
    pilot: Boolean(forSocket ? pilot === forSocket : pilot),
    failsafe: state.failsafe, rssi: state.rssi + wobble,
    uptimeMs: state.uptimeMs, clients: wss.clients.size,
    firmware: state.firmware, light: state.light,
    frontBallast: state.frontBallast, rearBallast: state.rearBallast,
    frontBallastDeg: state.frontBallastDeg, rearBallastDeg: state.rearBallastDeg,
    leftMotor: state.leftMotor, rightMotor: state.rightMotor,
    frameSize: state.frameSize, jpegQuality: state.jpegQuality, streamFps: state.streamFps,
    calibration: state.calibrated ? { ...calibration } : undefined,
  };
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json; charset=utf-8" };

async function serveStatic(res, path) {
  const relative = path === "/" ? "index.html" : path.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes("..")) return false;
  const file = join(webRoot, relative);
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": relative === "index.html" ? "no-store" : "public, max-age=300" });
    res.end(await readFile(file));
    return true;
  } catch { return false; }
}

function streamCamera(req, res) {
  res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store, no-cache, must-revalidate", "Connection": "close", "Access-Control-Allow-Origin": "*" });
  const sendFrame = () => {
    if (res.destroyed) return;
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${captureJpeg.length}\r\n\r\n`);
    res.write(captureJpeg);
    res.write("\r\n");
  };
  sendFrame();
  const timer = setInterval(sendFrame, 160);
  req.on("close", () => clearInterval(timer));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/status") {
    const status = publicState();
    delete status.pilot;
    return json(res, 200, status);
  }
  if (url.pathname === "/capture") {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": captureJpeg.length, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    return res.end(captureJpeg);
  }
  if (url.pathname === "/stream") return streamCamera(req, res);
  if (await serveStatic(res, url.pathname)) return;
  json(res, 404, { error: "not_found" });
});

const wss = new WebSocketServer({ noServer: true });

function sendPacket(socket, packet) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet));
}

function broadcastEvent(event, detail, severity = "info") {
  for (const client of wss.clients) sendPacket(client, { v: 1, type: "event", event, detail, severity, state: publicState(client) });
}

function ack(socket, request, ok = true, message = "") {
  sendPacket(socket, { v: 1, type: "ack", seq: Number(request.seq || 0), ok, message, rtt: Math.max(1, Date.now() - Number(request.ts || Date.now())), state: publicState(socket) });
}

const reject = (socket, request, message) => ack(socket, request, false, message);
function requiresPilot(socket, request) {
  if (pilot !== socket) { reject(socket, request, "Active pilot control is required"); return false; }
  return true;
}
const finiteUnit = (value) => Number.isFinite(value) && value >= -1 && value <= 1;
const validAngle = (value) => Number.isInteger(value) && value >= 0 && value <= 180;

function surfaceVehicle() {
  state.armed = false;
  state.leftMotor = state.rightMotor = 0;
  state.frontBallast = state.rearBallast = 0;
  state.frontBallastDeg = state.rearBallastDeg = 180;
}

function handleCommand(socket, raw) {
  let request;
  try { request = JSON.parse(String(raw)); } catch { return reject(socket, {}, "Invalid JSON packet"); }
  if (request.v !== 1 || typeof request.type !== "string") return reject(socket, request, "Unsupported protocol packet");
  switch (request.type) {
    case "hello": return ack(socket, request, true, "Simulator ready");
    case "heartbeat": if (pilot === socket) lastPilotHeartbeat = Date.now(); return ack(socket, request);
    case "claim":
      if (pilot && pilot !== socket) return reject(socket, request, "Another controller is the active pilot");
      pilot = socket; lastPilotHeartbeat = Date.now(); state.failsafe = false;
      broadcastEvent("pilot_claimed", "Control granted to this client");
      return ack(socket, request, true, "Pilot control granted");
    case "release":
      if (pilot === socket) { surfaceVehicle(); pilot = null; broadcastEvent("pilot_released", "Propulsion neutral; ballast moved to 180 degree surface position"); }
      return ack(socket, request, true, "Pilot control released");
    case "arm":
      if (!requiresPilot(socket, request)) return;
      if (!state.calibrated) return reject(socket, request, "Calibration is required before arming");
      state.armed = Boolean(request.armed); if (!state.armed) state.leftMotor = state.rightMotor = 0; state.failsafe = false;
      return ack(socket, request, true, state.armed ? "Propulsion armed" : "Propulsion disarmed");
    case "drive": {
      if (!requiresPilot(socket, request)) return;
      if (!state.armed) return reject(socket, request, "Propulsion is disarmed");
      const surge = Number(request.surge), yaw = Number(request.yaw), limit = Number(request.limit);
      if (!finiteUnit(surge) || !finiteUnit(yaw) || !Number.isFinite(limit) || limit < 0 || limit > 1) return reject(socket, request, "Drive values must be normalized");
      state.leftMotor = Math.max(-1, Math.min(1, surge + yaw)) * limit;
      state.rightMotor = Math.max(-1, Math.min(1, surge - yaw)) * limit;
      return ack(socket, request);
    }
    case "motors": {
      if (!requiresPilot(socket, request)) return;
      if (!state.armed) return reject(socket, request, "Propulsion is disarmed");
      const left = Number(request.left), right = Number(request.right), limit = Number(request.limit);
      if (!finiteUnit(left) || !finiteUnit(right) || !Number.isFinite(limit) || limit < 0 || limit > 1) return reject(socket, request, "Motor values must be normalized");
      state.leftMotor = left * limit;
      state.rightMotor = right * limit;
      return ack(socket, request);
    }
    case "ballast":
      if (!requiresPilot(socket, request)) return;
      if (!state.calibrated) return reject(socket, request, "Calibration is required");
      if (![request.front, request.rear].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return reject(socket, request, "Ballast values must be between 0 and 1");
      state.frontBallast = Number(request.front); state.rearBallast = Number(request.rear);
      state.frontBallastDeg = Math.round((1 - state.frontBallast) * 180);
      state.rearBallastDeg = Math.round((1 - state.rearBallast) * 180);
      return ack(socket, request, true, request.mode === "surface" ? "Ballast moving to surface" : request.mode === "dive" ? "Ballast moving to dive" : "");
    case "ballast_angle":
      if (!requiresPilot(socket, request)) return;
      if (!state.calibrated) return reject(socket, request, "Calibration is required");
      if (!validAngle(request.frontDeg) || !validAngle(request.rearDeg)) return reject(socket, request, "Ballast angles must be whole degrees from 0 to 180");
      state.frontBallastDeg = request.frontDeg; state.rearBallastDeg = request.rearDeg;
      state.frontBallast = 1 - request.frontDeg / 180; state.rearBallast = 1 - request.rearDeg / 180;
      return ack(socket, request, true, request.mode === "surface" ? "Ballast moving to 180 degree surface position" : request.mode === "dive" ? "Ballast moving to 0 degree dive position" : "");
    case "light":
      if (!requiresPilot(socket, request)) return;
      if (!Number.isFinite(request.value) || request.value < 0 || request.value > 1) return reject(socket, request, "Light value must be between 0 and 1");
      state.light = Number(request.value); return ack(socket, request);
    case "camera":
      if (!requiresPilot(socket, request)) return;
      if (!["QVGA", "VGA", "SVGA"].includes(request.frameSize) || !Number.isInteger(request.quality) || request.quality < 8 || request.quality > 30) return reject(socket, request, "Unsupported camera settings");
      state.frameSize = request.frameSize; state.jpegQuality = request.quality;
      return ack(socket, request, true, "Camera settings applied");
    case "calibration": {
      if (!requiresPilot(socket, request)) return;
      const pulseKeys = ["escMin", "escNeutral", "escMax", "frontSurface", "frontDive", "rearSurface", "rearDive"];
      if (request.benchConfirmed !== true || !pulseKeys.every((key) => Number.isInteger(request[key]) && request[key] >= 800 && request[key] <= 2200) || !(request.escMin < request.escNeutral && request.escNeutral < request.escMax)) return reject(socket, request, "Invalid or unsafe calibration values");
      Object.assign(calibration, request); state.calibrated = true; surfaceVehicle();
      return ack(socket, request, true, "Calibration saved; propulsion remains disarmed");
    }
    case "config":
      if (!requiresPilot(socket, request)) return;
      if (request.failsafeMs !== undefined) { if (![750, 1000, 1500].includes(request.failsafeMs)) return reject(socket, request, "Unsupported failsafe interval"); state.failsafeMs = request.failsafeMs; }
      if (request.apPassword !== undefined && String(request.apPassword).length < 8) return reject(socket, request, "Wi-Fi password must contain at least 8 characters");
      return ack(socket, request, true, request.restart ? "Saved in simulator; restart skipped" : "Configuration saved");
    case "config_import":
      if (!requiresPilot(socket, request)) return;
      if (!request.config || request.config.version !== 1) return reject(socket, request, "Unsupported configuration file");
      if ([750, 1000, 1500].includes(request.config.failsafeMs)) state.failsafeMs = request.config.failsafeMs;
      if (["QVGA", "VGA", "SVGA"].includes(request.config.frameSize)) state.frameSize = request.config.frameSize;
      if (Number.isInteger(request.config.jpegQuality) && request.config.jpegQuality >= 8 && request.config.jpegQuality <= 30) state.jpegQuality = request.config.jpegQuality;
      if (request.config.calibration) {
        const imported = request.config.calibration;
        const pulseKeys = ["escMin", "escNeutral", "escMax", "frontSurface", "frontDive", "rearSurface", "rearDive"];
        if (!pulseKeys.every((key) => Number.isInteger(imported[key]) && imported[key] >= 800 && imported[key] <= 2200) || !(imported.escMin < imported.escNeutral && imported.escNeutral < imported.escMax)) return reject(socket, request, "Imported calibration is invalid");
        Object.assign(calibration, imported);
        state.calibrated = true;
        surfaceVehicle();
      }
      return ack(socket, request, true, "Configuration imported");
    case "emergency_surface":
      if (!requiresPilot(socket, request)) return;
      surfaceVehicle(); state.failsafe = false;
      broadcastEvent("emergency_surface", "Propulsion neutral; both ballast servos commanded to 180 degree surface position", "error");
      return ack(socket, request, true, "Emergency surface activated");
    default: return reject(socket, request, "Unknown command type");
  }
}

wss.on("connection", (socket) => {
  state.clients = wss.clients.size;
  sendPacket(socket, { v: 1, type: "event", event: "connected", detail: "Local simulator link established", state: publicState(socket) });
  socket.on("message", (data) => handleCommand(socket, data));
  socket.on("close", () => {
    if (pilot === socket) {
      surfaceVehicle(); state.failsafe = true; pilot = null;
      broadcastEvent("failsafe", "Pilot disconnected; outputs neutral and ballast moved to 180 degrees", "error");
    }
    state.clients = wss.clients.size;
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client, req));
});

setInterval(() => {
  if (pilot && Date.now() - lastPilotHeartbeat > state.failsafeMs) {
    surfaceVehicle(); state.failsafe = true; pilot = null;
    broadcastEvent("failsafe", "Heartbeat timeout; outputs neutral and ballast moved to 180 degrees", "error");
  }
}, 100);

await loadCapture();
server.listen(port, "0.0.0.0", () => process.stdout.write(`Submarine RC simulator: http://localhost:${port}\n`));
