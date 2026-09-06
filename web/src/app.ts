import { clamp, mixDrive, PROTOCOL_VERSION, safeJson, validPulse } from "./control.js";

declare global {
  interface Window {
    SubmarineAndroid?: { saveBase64(name: string, mime: string, data: string): void };
  }
}

type ViewName = "pilot" | "camera" | "sonar" | "logs" | "settings";
type LogType = "control" | "camera" | "system" | "error";
type MissionLog = { at: string; type: LogType; event: string; detail: string };
type CalibrationState = {
  escMin: number; escNeutral: number; escMax: number;
  frontSurface: number; frontDive: number; rearSurface: number; rearDive: number;
  invertLeft: boolean; invertRight: boolean; invertFront: boolean; invertRear: boolean;
};
type DeviceState = {
  calibrated: boolean;
  armed: boolean;
  pilot: boolean;
  failsafe: boolean;
  rssi: number | null;
  uptimeMs: number;
  clients: number;
  firmware: string;
  light: number;
  frontBallast: number;
  rearBallast: number;
  frameSize: string;
  jpegQuality: number;
  streamFps: number;
  calibration?: CalibrationState;
};

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element #${id}`);
  return element as T;
};

const views: Record<ViewName, string> = {
  pilot: "Pilot console",
  camera: "Camera control",
  sonar: "Sonar & signal",
  logs: "Mission logs",
  settings: "Vehicle settings",
};

const defaultState: DeviceState = {
  calibrated: false,
  armed: false,
  pilot: false,
  failsafe: false,
  rssi: null,
  uptimeMs: 0,
  clients: 0,
  firmware: "—",
  light: 0,
  frontBallast: 0,
  rearBallast: 0,
  frameSize: "VGA",
  jpegQuality: 12,
  streamFps: 0,
};

const app = $("app");
const boot = $("boot");
const toast = $("toast");
const linkBadge = $("linkBadge");
const roleBadge = $("roleBadge");
const stateBanner = $("stateBanner");
const joystick = $("joystick");
const joystickKnob = $("joystickKnob");
const emergencyDialog = $("emergencyDialog") as HTMLDialogElement;
const pilotFeed = $("pilotFeed") as HTMLImageElement;
const cameraFeed = $("cameraFeed") as HTMLImageElement;

let state = { ...defaultState };
let socket: WebSocket | null = null;
let sequence = 0;
let reconnectTimer = 0;
let pollTimer = 0;
let heartbeatTimer = 0;
let joystickSendTimer = 0;
let currentVector = { x: 0, y: 0 };
let sentCommands = 0;
let missedCommands = 0;
let latencyMs = 0;
let signalHistory: number[] = [];
let connectionHistory: Array<{ at: string; label: string; good: boolean }> = [];
let logs: MissionLog[] = loadLogs();
let toastTimer = 0;
let mediaRecorder: MediaRecorder | null = null;
let recordTimer = 0;
let recordingChunks: Blob[] = [];
let calibrationLoaded = false;

const isSimulator = ["localhost", "127.0.0.1"].includes(location.hostname);
const httpBase = isSimulator ? `${location.protocol}//${location.host}` : "http://192.168.4.1";
const wsBase = isSimulator ? `ws://${location.host}` : "ws://192.168.4.1";

function showToast(message: string, isError = false): void {
  toast.textContent = message;
  toast.style.borderColor = isError ? "rgba(240,111,116,.4)" : "";
  toast.style.background = isError ? "#342025" : "";
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3000);
}

function addLog(type: LogType, event: string, detail = ""): void {
  logs.unshift({ at: new Date().toISOString(), type, event, detail });
  logs = logs.slice(0, 500);
  localStorage.setItem("subrc.logs.v1", JSON.stringify(logs));
  renderLogs();
}

function loadLogs(): MissionLog[] {
  try {
    const raw = localStorage.getItem("subrc.logs.v1");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addConnection(label: string, good: boolean): void {
  connectionHistory.unshift({ at: new Date().toISOString(), label, good });
  connectionHistory = connectionHistory.slice(0, 8);
  renderConnectionHistory();
}

function showView(name: ViewName): void {
  document.querySelectorAll<HTMLElement>(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === name));
  document.querySelectorAll<HTMLButtonElement>("[data-view-target]").forEach((button) => {
    const active = button.dataset.viewTarget === name;
    button.classList.toggle("active", active && button.classList.contains("nav-item"));
    if (button.classList.contains("nav-item")) active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  $("pageTitle").textContent = `RC-01 · ${views[name]}`;
  if (name === "logs") renderLogs();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setConnected(connected: boolean): void {
  linkBadge.classList.toggle("offline", !connected);
  linkBadge.querySelector("span")!.textContent = connected ? "Link online" : "Offline";
  $("footerDot").style.background = connected ? "var(--green)" : "var(--red)";
  $("footerStatus").textContent = connected ? "Telemetry link active" : "Not connected";
  if (!connected) {
    state.armed = false;
    state.pilot = false;
    updateStateUI();
  }
}

function updateStateUI(): void {
  const connected = socket?.readyState === WebSocket.OPEN;
  roleBadge.textContent = state.pilot ? "Active pilot" : "Monitor";
  roleBadge.style.color = state.pilot ? "var(--green)" : "";
  $("claimButton").textContent = state.pilot ? "Release control" : "Claim control";
  const armButton = $("armButton") as HTMLButtonElement;
  armButton.textContent = state.armed ? "Disarm propulsion" : "Arm propulsion";
  armButton.classList.toggle("danger", state.armed);
  armButton.disabled = !connected || !state.pilot || !state.calibrated;
  joystick.classList.toggle("disabled", !state.armed);
  const ballastEnabled = connected && state.pilot && state.calibrated;
  ["frontBallast", "rearBallast", "surfaceButton", "diveButton", "emergencyButton"].forEach((id) => ($(id) as HTMLInputElement | HTMLButtonElement).disabled = !ballastEnabled);
  $("calibrationBadge").textContent = state.calibrated ? "Calibrated" : "Required";
  $("calibrationBadge").classList.toggle("warning", !state.calibrated);
  $("controlState").textContent = !connected ? "Disconnected" : state.failsafe ? "Failsafe" : state.armed ? "Armed" : state.pilot ? "Disarmed" : "Monitor only";
  $("failsafeMetric").textContent = state.failsafe ? "Triggered" : "Ready";
  $("rssiMetric").textContent = state.rssi === null ? "Unavailable" : `${state.rssi} dBm`;
  $("feedRssi").textContent = state.rssi === null ? "— dBm" : `${state.rssi} dBm`;
  $("sonarRssi").textContent = state.rssi === null ? "—" : `${state.rssi} dBm`;
  $("latencyMetric").textContent = latencyMs ? `${latencyMs} ms` : "—";
  $("sonarLatency").textContent = latencyMs ? `${latencyMs} ms` : "—";
  const loss = sentCommands ? Math.round((missedCommands / sentCommands) * 100) : 0;
  $("lossMetric").textContent = `${loss}%`;
  $("sonarLoss").textContent = `${loss}%`;
  $("uptimeMetric").textContent = formatDuration(state.uptimeMs);
  $("clientCount").textContent = String(state.clients);
  $("firmwareVersion").textContent = state.firmware;
  $("frontBallastOutput").textContent = `${Math.round(state.frontBallast * 100)}%`;
  $("rearBallastOutput").textContent = `${Math.round(state.rearBallast * 100)}%`;
  ($("frontBallast") as HTMLInputElement).value = String(Math.round(state.frontBallast * 100));
  ($("rearBallast") as HTMLInputElement).value = String(Math.round(state.rearBallast * 100));
  setRangeFill($("frontBallast") as HTMLInputElement);
  setRangeFill($("rearBallast") as HTMLInputElement);
  $("feedResolution").textContent = state.frameSize;
  ($("frameSize") as HTMLSelectElement).value = state.frameSize;
  ($("jpegQuality") as HTMLInputElement).value = String(state.jpegQuality);
  $("qualityOutput").textContent = String(state.jpegQuality);
  $("feedFps").textContent = state.streamFps > 0 ? `${state.streamFps.toFixed(1)} FPS` : "STREAM IDLE";
  $("cameraFps").textContent = state.streamFps > 0 ? `${state.streamFps.toFixed(1)} FPS` : "STREAM IDLE";

  stateBanner.className = "state-banner";
  if (!connected) {
    stateBanner.classList.add("warning");
    stateBanner.innerHTML = "<strong>Controller unavailable</strong><span>Join SUB-RC Wi-Fi and reconnect to 192.168.4.1.</span>";
  } else if (!state.calibrated) {
    stateBanner.classList.add("warning");
    stateBanner.innerHTML = "<strong>Calibration required</strong><span>Propulsion remains locked. Open Settings and calibrate on a dry bench.</span>";
  } else if (state.failsafe) {
    stateBanner.classList.add("danger");
    stateBanner.innerHTML = "<strong>Failsafe triggered</strong><span>Propulsion is neutral and ballast is moving to surface.</span>";
  } else if (!state.pilot) {
    stateBanner.classList.add("warning");
    stateBanner.innerHTML = "<strong>Monitor mode</strong><span>Claim control before operating the submarine.</span>";
  } else {
    stateBanner.classList.add("ok");
    stateBanner.innerHTML = `<strong>${state.armed ? "Propulsion armed" : "Control ready"}</strong><span>${state.armed ? "Live drive commands are enabled." : "Outputs are safe; arm only when ready."}</span>`;
  }
}

function formatDuration(ms: number): string {
  if (!ms) return "—";
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function send(type: string, payload: Record<string, unknown> = {}, log = true): number {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (log) showToast("Controller is offline", true);
    return -1;
  }
  const seq = ++sequence;
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type, seq, ts: Date.now(), ...payload }));
  if (type !== "heartbeat") sentCommands++;
  if (log) addLog("control", type.replace(/_/g, " "), JSON.stringify(payload));
  return seq;
}

function connect(): void {
  window.clearTimeout(reconnectTimer);
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  setConnected(false);
  linkBadge.querySelector("span")!.textContent = "Connecting";
  try {
    socket = new WebSocket(`${wsBase}/ws`);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.addEventListener("open", () => {
    setConnected(true);
    addConnection("Control link connected", true);
    addLog("system", "Control link connected", wsBase);
    send("hello", { client: "web", protocol: PROTOCOL_VERSION }, false);
    startHeartbeat();
    refreshStatus();
    const stream = `${httpBase}/stream?ts=${Date.now()}`;
    pilotFeed.src = stream;
    cameraFeed.src = stream;
  });
  socket.addEventListener("message", (event) => handleMessage(String(event.data)));
  socket.addEventListener("close", () => {
    setConnected(false);
    addConnection("Control link disconnected", false);
    addLog("error", "Control link disconnected", "Automatic reconnect scheduled");
    stopHeartbeat();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => socket?.close());
}

function scheduleReconnect(): void {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, 2000);
}

function handleMessage(text: string): void {
  const message = safeJson(text);
  if (!message) {
    addLog("error", "Invalid controller message", text.slice(0, 100));
    return;
  }
  if (message.type === "ack") {
    if (typeof message.rtt === "number") latencyMs = Math.round(message.rtt);
    if (message.ok === false) {
      missedCommands++;
      showToast(String(message.message ?? "Command rejected"), true);
      addLog("error", "Command rejected", String(message.message ?? "Unknown reason"));
    } else if (message.message) showToast(String(message.message));
  }
  if (message.type === "event") {
    const event = String(message.event ?? "Controller event");
    addLog(message.severity === "error" ? "error" : "system", event, String(message.detail ?? ""));
    if (event === "failsafe") showToast("Failsafe triggered: surfacing", true);
  }
  const incoming = message.state;
  if (incoming && typeof incoming === "object") applyState(incoming as Partial<DeviceState>);
}

function applyState(incoming: Partial<DeviceState>): void {
  state = { ...state, ...incoming };
  if (incoming.calibration && !calibrationLoaded) {
    const calibration = incoming.calibration;
    const numbers: Array<[string, keyof CalibrationState]> = [
      ["escMin", "escMin"], ["escNeutral", "escNeutral"], ["escMax", "escMax"],
      ["frontSurface", "frontSurface"], ["frontDive", "frontDive"],
      ["rearSurface", "rearSurface"], ["rearDive", "rearDive"],
    ];
    numbers.forEach(([id, key]) => (($(id) as HTMLInputElement).value = String(calibration[key])));
    (["invertLeft", "invertRight", "invertFront", "invertRear"] as const).forEach((key) => (($(key) as HTMLInputElement).checked = calibration[key]));
    calibrationLoaded = true;
  }
  if (typeof state.rssi === "number") {
    signalHistory.push(state.rssi);
    signalHistory = signalHistory.slice(-40);
    renderSignalChart();
  }
  updateStateUI();
}

async function refreshStatus(): Promise<void> {
  try {
    const started = performance.now();
    const response = await fetch(`${httpBase}/api/status?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as Partial<DeviceState>;
    latencyMs = Math.round(performance.now() - started);
    applyState(data);
  } catch {
    if (socket?.readyState === WebSocket.OPEN) missedCommands++;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = window.setInterval(() => send("heartbeat", {}, false), 250);
  pollTimer = window.setInterval(refreshStatus, 1000);
}

function stopHeartbeat(): void {
  window.clearInterval(heartbeatTimer);
  window.clearInterval(pollTimer);
}

function updateJoystick(event: PointerEvent): void {
  if (!state.armed) return;
  const rect = joystick.getBoundingClientRect();
  const x = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1);
  const y = clamp(-(((event.clientY - rect.top) / rect.height) * 2 - 1));
  currentVector = { x, y };
  joystickKnob.style.transform = `translate(calc(-50% + ${x * rect.width * .32}px),calc(-50% + ${-y * rect.height * .32}px))`;
  $("vectorOutput").textContent = `X ${x.toFixed(2)} · Y ${y.toFixed(2)}`;
  const limit = Number(($("throttleLimit") as HTMLInputElement).value) / 100;
  const mix = mixDrive(y, x, limit);
  $("leftMotor").textContent = describeMotor(mix.left);
  $("rightMotor").textContent = describeMotor(mix.right);
  if (!joystickSendTimer) joystickSendTimer = window.setTimeout(() => {
    send("drive", { surge: currentVector.y, yaw: currentVector.x, limit }, false);
    joystickSendTimer = 0;
  }, 80);
}

function centerJoystick(sendStop = true): void {
  currentVector = { x: 0, y: 0 };
  joystickKnob.style.transform = "translate(-50%,-50%)";
  $("vectorOutput").textContent = "X 0.00 · Y 0.00";
  $("leftMotor").textContent = "Neutral";
  $("rightMotor").textContent = "Neutral";
  if (sendStop && state.armed) send("drive", { surge: 0, yaw: 0, limit: 0 }, false);
}

function describeMotor(value: number): string {
  if (Math.abs(value) < .03) return "Neutral";
  return `${value > 0 ? "Forward" : "Reverse"} ${Math.round(Math.abs(value) * 100)}%`;
}

function setRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const percent = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty("--value", `${percent}%`);
}

function setLight(value: number): void {
  const safe = Math.round(clamp(value / 100, 0, 1) * 100);
  ["pilotLight", "cameraLight"].forEach((id) => {
    const input = $(id) as HTMLInputElement;
    input.value = String(safe);
    setRangeFill(input);
  });
  $("pilotLightOutput").textContent = `${safe}%`;
  $("cameraLightOutput").textContent = `${safe}%`;
  send("light", { value: safe / 100 }, false);
}

function renderLogs(): void {
  const rows = $("logRows") as HTMLTableSectionElement;
  const query = (document.getElementById("logSearch") as HTMLInputElement | null)?.value.toLowerCase() ?? "";
  const filter = (document.getElementById("logFilter") as HTMLSelectElement | null)?.value ?? "all";
  const matching = logs.filter((entry) => (filter === "all" || entry.type === filter) && `${entry.event} ${entry.detail}`.toLowerCase().includes(query));
  rows.innerHTML = matching.map((entry) => `<tr><td>${escapeHtml(new Date(entry.at).toLocaleTimeString())}</td><td>${entry.type}</td><td>${escapeHtml(entry.event)}</td><td>${escapeHtml(entry.detail)}</td></tr>`).join("");
  $("emptyLogs").style.display = matching.length ? "none" : "grid";
}

function renderConnectionHistory(): void {
  const list = $("connectionHistory");
  list.innerHTML = connectionHistory.length ? connectionHistory.slice(0, 5).map((entry) => `<li><i class="${entry.good ? "" : "neutral"}"></i><div><strong>${escapeHtml(entry.label)}</strong><span>${new Date(entry.at).toLocaleTimeString()}</span></div></li>`).join("") : '<li><i class="neutral"></i><div><strong>No connection yet</strong><span>Waiting for RC-01</span></div></li>';
}

function renderSignalChart(): void {
  const chart = $("signalChart");
  if (!signalHistory.length) return;
  chart.innerHTML = signalHistory.map((rssi) => {
    const height = clamp((rssi + 100) / 60, .08, 1) * 100;
    return `<i class="bar" style="height:${height}%" title="${rssi} dBm"></i>`;
  }).join("");
  const last = signalHistory[signalHistory.length - 1];
  $("signalGrade").textContent = last >= -55 ? "Strong" : last >= -70 ? "Usable" : "Weak";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function downloadBlob(name: string, blob: Blob): void {
  if (window.SubmarineAndroid) {
    const reader = new FileReader();
    reader.onload = () => window.SubmarineAndroid!.saveBase64(name, blob.type, String(reader.result).split(",")[1]);
    reader.readAsDataURL(blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function captureImage(): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/capture?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Capture failed");
    const blob = await response.blob();
    const name = `submarine-${new Date().toISOString().replace(/:/g, "-")}.jpg`;
    downloadBlob(name, blob);
    const count = Number(localStorage.getItem("subrc.snapshots") ?? 0) + 1;
    localStorage.setItem("subrc.snapshots", String(count));
    $("snapshotCount").textContent = String(count);
    addLog("camera", "Snapshot captured", name);
    showToast("JPEG snapshot saved");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Capture failed", true);
  }
}

async function toggleRecording(): Promise<void> {
  const button = $("recordButton");
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    button.textContent = "Start recording";
    window.clearInterval(recordTimer);
    return;
  }
  const canvas = $("recordCanvas") as HTMLCanvasElement;
  const context = canvas.getContext("2d");
  if (!context || !canvas.captureStream || typeof MediaRecorder === "undefined") {
    showToast("WebM recording is not supported on this device", true);
    return;
  }
  canvas.width = 640;
  canvas.height = 480;
  recordingChunks = [];
  const draw = () => {
    try { context.drawImage(cameraFeed, 0, 0, canvas.width, canvas.height); } catch { /* wait for a frame */ }
  };
  draw();
  recordTimer = window.setInterval(draw, 100);
  const stream = canvas.captureStream(10);
  mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm" });
  mediaRecorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.push(event.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordingChunks, { type: "video/webm" });
    const name = `submarine-${new Date().toISOString().replace(/:/g, "-")}.webm`;
    downloadBlob(name, blob);
    const count = Number(localStorage.getItem("subrc.recordings") ?? 0) + 1;
    localStorage.setItem("subrc.recordings", String(count));
    $("recordingCount").textContent = String(count);
    addLog("camera", "Recording saved", `${name} · ${Math.round(blob.size / 1024)} KB`);
    showToast("WebM recording saved");
  };
  mediaRecorder.start(1000);
  button.textContent = "Stop recording";
  addLog("camera", "Recording started", "10 FPS client-side WebM");
  showToast("Recording started");
}

function exportLogs(): void {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const csv = ["timestamp,type,event,detail", ...logs.map((entry) => [entry.at, entry.type, entry.event, entry.detail].map(quote).join(","))].join("\n");
  downloadBlob(`submarine-log-${Date.now()}.csv`, new Blob([csv], { type: "text/csv" }));
  showToast("Mission log exported");
}

function calibrationPayload(): Record<string, unknown> | null {
  const values = ["escMin", "escNeutral", "escMax", "frontSurface", "frontDive", "rearSurface", "rearDive"].map((id) => Number(($(id) as HTMLInputElement).value));
  if (!values.every(validPulse) || !(values[0] < values[1] && values[1] < values[2])) {
    showToast("Use valid 800–2200 µs pulses with min < neutral < max", true);
    return null;
  }
  return {
    benchConfirmed: true,
    escMin: values[0], escNeutral: values[1], escMax: values[2],
    frontSurface: values[3], frontDive: values[4], rearSurface: values[5], rearDive: values[6],
    invertLeft: ($("invertLeft") as HTMLInputElement).checked,
    invertRight: ($("invertRight") as HTMLInputElement).checked,
    invertFront: ($("invertFront") as HTMLInputElement).checked,
    invertRear: ($("invertRear") as HTMLInputElement).checked,
  };
}

document.querySelectorAll<HTMLElement>("[data-view-target]").forEach((element) => element.addEventListener("click", () => showView(element.dataset.viewTarget as ViewName)));
$("reconnectButton").addEventListener("click", connect);
$("refreshStatus").addEventListener("click", () => { refreshStatus(); showToast("Status refreshed"); });
$("claimButton").addEventListener("click", () => send(state.pilot ? "release" : "claim"));
$("armButton").addEventListener("click", () => send("arm", { armed: !state.armed }));

joystick.addEventListener("pointerdown", (event) => {
  if (!state.armed) return;
  joystick.setPointerCapture(event.pointerId);
  updateJoystick(event);
});
joystick.addEventListener("pointermove", (event) => { if (joystick.hasPointerCapture(event.pointerId)) updateJoystick(event); });
joystick.addEventListener("pointerup", (event) => { joystick.releasePointerCapture(event.pointerId); centerJoystick(); });
joystick.addEventListener("pointercancel", () => centerJoystick());
joystick.addEventListener("keydown", (event) => {
  if (!state.armed) return;
  const step = .1;
  if (event.key === "ArrowUp") currentVector.y = clamp(currentVector.y + step);
  else if (event.key === "ArrowDown") currentVector.y = clamp(currentVector.y - step);
  else if (event.key === "ArrowLeft") currentVector.x = clamp(currentVector.x - step);
  else if (event.key === "ArrowRight") currentVector.x = clamp(currentVector.x + step);
  else if (event.key === "Escape" || event.key === " ") centerJoystick();
  else return;
  event.preventDefault();
  send("drive", { surge: currentVector.y, yaw: currentVector.x, limit: Number(($("throttleLimit") as HTMLInputElement).value) / 100 }, false);
});

document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => { setRangeFill(input); input.addEventListener("input", () => setRangeFill(input)); });
$("throttleLimit").addEventListener("input", () => $("throttleOutput").textContent = `${($("throttleLimit") as HTMLInputElement).value}%`);
["pilotLight", "cameraLight"].forEach((id) => $(id).addEventListener("input", () => setLight(Number(($(id) as HTMLInputElement).value))));
["frontBallast", "rearBallast"].forEach((id) => $(id).addEventListener("input", () => {
  const front = Number(($("frontBallast") as HTMLInputElement).value) / 100;
  const rear = Number(($("rearBallast") as HTMLInputElement).value) / 100;
  $("frontBallastOutput").textContent = `${Math.round(front * 100)}%`;
  $("rearBallastOutput").textContent = `${Math.round(rear * 100)}%`;
  send("ballast", { front, rear }, false);
}));
$("surfaceButton").addEventListener("click", () => send("ballast", { front: 0, rear: 0, mode: "surface" }));
$("diveButton").addEventListener("click", () => send("ballast", { front: 1, rear: 1, mode: "dive" }));
$("emergencyButton").addEventListener("click", () => emergencyDialog.showModal());
$("cancelEmergency").addEventListener("click", () => emergencyDialog.close());
$("confirmEmergency").addEventListener("click", () => { send("emergency_surface"); emergencyDialog.close(); centerJoystick(false); });
$("captureButton").addEventListener("click", captureImage);
$("recordButton").addEventListener("click", toggleRecording);
$("overlayToggle").addEventListener("change", () => $("cameraOverlay").toggleAttribute("hidden", !(($("overlayToggle") as HTMLInputElement).checked)));
$("frameSize").addEventListener("change", () => send("camera", { frameSize: ($("frameSize") as HTMLSelectElement).value, quality: Number(($("jpegQuality") as HTMLInputElement).value) }));
$("jpegQuality").addEventListener("input", () => $("qualityOutput").textContent = ($("jpegQuality") as HTMLInputElement).value);
$("jpegQuality").addEventListener("change", () => send("camera", { frameSize: ($("frameSize") as HTMLSelectElement).value, quality: Number(($("jpegQuality") as HTMLInputElement).value) }));
$("runDiagnostics").addEventListener("click", async () => { await refreshStatus(); addLog("system", "Connection diagnostics completed", `${latencyMs} ms`); showToast("Diagnostics completed"); });
$("clearHistory").addEventListener("click", () => { connectionHistory = []; renderConnectionHistory(); showToast("Connection history cleared"); });
$("logSearch").addEventListener("input", renderLogs);
$("logFilter").addEventListener("change", renderLogs);
$("exportLogs").addEventListener("click", exportLogs);
$("clearLogs").addEventListener("click", () => { if (confirm("Clear all locally stored mission logs?")) { logs = []; localStorage.removeItem("subrc.logs.v1"); renderLogs(); showToast("Mission logs cleared"); } });
$("propsRemoved").addEventListener("change", () => ($("saveCalibration") as HTMLButtonElement).disabled = !(($("propsRemoved") as HTMLInputElement).checked) || !state.pilot);
$("saveCalibration").addEventListener("click", () => { const payload = calibrationPayload(); if (payload) send("calibration", payload); });
$("saveFailsafe").addEventListener("click", () => send("config", { failsafeMs: Number(($("failsafeTimeout") as HTMLSelectElement).value) }));
$("saveWifi").addEventListener("click", () => { const password = ($("apPassword") as HTMLInputElement).value; if (password.length < 8) return showToast("Wi-Fi password must contain at least 8 characters", true); if (confirm("Save the new Wi-Fi password and restart RC-01?")) send("config", { apPassword: password, restart: true }); });
$("exportConfig").addEventListener("click", () => downloadBlob(`submarine-config-${Date.now()}.json`, new Blob([JSON.stringify({ version: 1, failsafeMs: Number(($("failsafeTimeout") as HTMLSelectElement).value), frameSize: ($("frameSize") as HTMLSelectElement).value, jpegQuality: Number(($("jpegQuality") as HTMLInputElement).value), calibration: calibrationPayload() }, null, 2)], { type: "application/json" })));
$("importConfig").addEventListener("change", async () => { const file = (($("importConfig") as HTMLInputElement).files ?? [])[0]; if (!file) return; const parsed = safeJson(await file.text()); if (!parsed || parsed.version !== 1) return showToast("Unsupported configuration file", true); send("config_import", { config: parsed }); });

window.addEventListener("beforeunload", () => { if (state.pilot) send("release", {}, false); stopHeartbeat(); });
window.addEventListener("blur", () => { if (state.armed) centerJoystick(); });
pilotFeed.addEventListener("error", () => $("feedFps").textContent = "STREAM WAITING");
cameraFeed.addEventListener("error", () => $("cameraFps").textContent = "STREAM WAITING");

$("snapshotCount").textContent = localStorage.getItem("subrc.snapshots") ?? "0";
$("recordingCount").textContent = localStorage.getItem("subrc.recordings") ?? "0";
renderLogs();
renderConnectionHistory();
window.setTimeout(() => { boot.hidden = true; app.hidden = false; updateStateUI(); connect(); }, 400);
