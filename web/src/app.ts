import { clamp, directMotorLevels, effectiveBallastAngles, PROTOCOL_VERSION, safeJson, validPulse } from "./control.js";

declare global {
  interface Window {
    SubmarineAndroid?: {
      saveBase64(name: string, mime: string, data: string): void;
      openWifiSettings(): void;
    };
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
  frontBallastDeg: number;
  rearBallastDeg: number;
  leftMotor: number;
  rightMotor: number;
  frameSize: string;
  jpegQuality: number;
  streamFps: number;
  cameraReady: boolean;
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
  frontBallastDeg: 180,
  rearBallastDeg: 180,
  leftMotor: 0,
  rightMotor: 0,
  frameSize: "VGA",
  jpegQuality: 12,
  streamFps: 0,
  cameraReady: true,
};

const app = $("app");
const boot = $("boot");
const toast = $("toast");
const linkBadge = $("linkBadge");
const roleBadge = $("roleBadge");
const stateBanner = $("stateBanner");
const emergencyDialog = $("emergencyDialog") as HTMLDialogElement;
const pilotFeed = $("pilotFeed") as HTMLImageElement;
const cameraFeed = $("cameraFeed") as HTMLImageElement;

let state = { ...defaultState };
let socket: WebSocket | null = null;
let pilotToken = 0;
let actuatorSequence = 0;
let sequence = 0;
let reconnectTimer = 0;
let pollTimer = 0;
let heartbeatTimer = 0;
let motorSendTimer = 0;
let ballastSendTimer = 0;
let motorInput = { left: 0, right: 0 };
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
let ballastUiInitialized = false;
let connectionAttempts = 0;
let activeView: ViewName = "pilot";

const isSimulator = ["localhost", "127.0.0.1"].includes(location.hostname);
const httpBase = isSimulator ? `${location.protocol}//${location.host}` : "http://192.168.4.1";
const wsBase = isSimulator ? `ws://${location.host}` : "ws://192.168.4.1";
const streamBase = isSimulator ? `${httpBase}/stream` : "http://192.168.4.1:81/stream";

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
  if (name !== "pilot") neutralizeMotors();
  activeView = name;
  document.querySelectorAll<HTMLElement>(".view").forEach((view) => view.classList.toggle("active", view.dataset.view === name));
  document.querySelectorAll<HTMLButtonElement>("[data-view-target]").forEach((button) => {
    const active = button.dataset.viewTarget === name;
    button.classList.toggle("active", active && button.classList.contains("nav-item"));
    if (button.classList.contains("nav-item")) active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  $("pageTitle").textContent = `RC-01 · ${views[name]}`;
  if (name === "logs") renderLogs();
  refreshActiveCameraStream();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function stopCameraStreams(): void {
  pilotFeed.removeAttribute("src");
  cameraFeed.removeAttribute("src");
}

function refreshActiveCameraStream(): void {
  stopCameraStreams();
  if (socket?.readyState !== WebSocket.OPEN || !state.cameraReady) return;
  const target = activeView === "camera" ? cameraFeed : activeView === "pilot" ? pilotFeed : null;
  if (target) target.src = `${streamBase}?ts=${Date.now()}`;
}

function setLinkStatus(label: string, phase: "online" | "offline" | "connecting"): void {
  linkBadge.classList.toggle("offline", phase === "offline");
  linkBadge.classList.toggle("connecting", phase === "connecting");
  linkBadge.querySelector("span")!.textContent = label;
  linkBadge.setAttribute("aria-label", `Submarine connection: ${label}`);
}

function setConnected(connected: boolean): void {
  setLinkStatus(connected ? "Link online" : "Offline", connected ? "online" : "offline");
  $("footerDot").style.background = connected ? "var(--green)" : "var(--red)";
  $("footerStatus").textContent = connected ? "Telemetry link active" : "Not connected";
  if (!connected) {
    stopCameraStreams();
    neutralizeMotors(false);
    ballastUiInitialized = false;
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
  const motorEnabled = Boolean(connected && state.pilot && state.armed);
  ["leftThrottle", "rightThrottle", "stopMotors"].forEach((id) => ($(id) as HTMLInputElement | HTMLButtonElement).disabled = !motorEnabled);
  if (!motorEnabled && (motorInput.left !== 0 || motorInput.right !== 0)) neutralizeMotors(false);
  const ballastEnabled = connected && state.pilot && state.calibrated;
  ["masterBallast", "frontTrim", "rearTrim", "surfaceButton", "diveButton", "emergencyButton"].forEach((id) => ($(id) as HTMLInputElement | HTMLButtonElement).disabled = !ballastEnabled);
  $("calibrationBadge").textContent = state.calibrated ? "Calibrated" : "Required";
  $("calibrationBadge").classList.toggle("warning", !state.calibrated);
  $("controlState").textContent = !connected ? "Disconnected" : state.failsafe ? "Failsafe" : state.armed ? "Armed" : state.pilot ? "Disarmed" : "Monitor only";
  $("failsafeMetric").textContent = state.failsafe ? "Triggered" : "Ready";
  $("rssiMetric").textContent = state.rssi === null ? "Unavailable" : `${state.rssi} dBm`;
  $("feedRssi").textContent = state.rssi === null ? "— dBm" : `${state.rssi} dBm`;
  $("sonarRssi").textContent = state.rssi === null ? "—" : `${state.rssi} dBm`;
  $("latencyMetric").textContent = latencyMs ? `${latencyMs} ms` : "—";
  $("sonarLatency").textContent = latencyMs ? `${latencyMs} ms` : "—";
  $("feedLatency").textContent = latencyMs ? `${latencyMs} ms` : "— ms";
  const loss = sentCommands ? Math.round((missedCommands / sentCommands) * 100) : 0;
  $("lossMetric").textContent = `${loss}%`;
  $("sonarLoss").textContent = `${loss}%`;
  $("uptimeMetric").textContent = formatDuration(state.uptimeMs);
  $("clientCount").textContent = String(state.clients);
  $("firmwareVersion").textContent = state.firmware;
  $("leftMotor").textContent = describeMotor(state.leftMotor);
  $("rightMotor").textContent = describeMotor(state.rightMotor);
  $("frontBallastOutput").textContent = `${Math.round(state.frontBallastDeg)}°`;
  $("rearBallastOutput").textContent = `${Math.round(state.rearBallastDeg)}°`;
  const averageBallast = Math.round((state.frontBallastDeg + state.rearBallastDeg) / 2);
  $("ballastState").textContent = averageBallast === 0 ? "0° Dive" : averageBallast === 180 ? "180° Surface" : `${averageBallast}° Hold`;
  $("feedResolution").textContent = state.frameSize;
  ($("frameSize") as HTMLSelectElement).value = state.frameSize;
  ($("jpegQuality") as HTMLInputElement).value = String(state.jpegQuality);
  $("qualityOutput").textContent = String(state.jpegQuality);
  $("feedFps").textContent = state.streamFps > 0 ? `${state.streamFps.toFixed(1)} FPS` : "STREAM IDLE";
  $("cameraFps").textContent = state.streamFps > 0 ? `${state.streamFps.toFixed(1)} FPS` : "STREAM IDLE";
  const cameraBadge = $("cameraReadyBadge");
  cameraBadge.classList.toggle("offline", !connected || !state.cameraReady);
  cameraBadge.innerHTML = `<i></i>${!connected ? "OFFLINE" : state.cameraReady ? "LIVE" : "CAMERA ERROR"}`;
  $("cameraStreamStatus").textContent = !connected ? "OFFLINE" : state.cameraReady ? "LIVE" : "CAMERA ERROR";

  stateBanner.className = "state-banner";
  if (!connected) {
    stateBanner.classList.add("warning");
    stateBanner.innerHTML = "<strong>App ready · submarine offline</strong><span>UI remains available. Join SUB-RC Wi-Fi, then tap Reconnect.</span>";
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

function sendActuator(type: "motors" | "ballast_angle" | "light", payload: Record<string, unknown>, log = false): void {
  if (isSimulator) {
    send(type, payload, log);
    return;
  }
  if (!pilotToken || socket?.readyState !== WebSocket.OPEN) {
    if (log) showToast("Claim pilot control first", true);
    return;
  }
  const params = new URLSearchParams({ token: String(pilotToken), seq: String(++actuatorSequence) });
  if (type === "motors") {
    params.set("left", String(payload.left));
    params.set("right", String(payload.right));
    params.set("limit", String(payload.limit));
  } else if (type === "ballast_angle") {
    params.set("frontDeg", String(payload.frontDeg));
    params.set("rearDeg", String(payload.rearDeg));
  } else {
    params.set("light", String(payload.value));
  }
  sentCommands++;
  if (log) addLog("control", type.replace(/_/g, " "), JSON.stringify(payload));
  void fetch(`${httpBase}/set?${params}`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const message = await response.json() as { state?: Partial<DeviceState> };
      if (message.state) applyState(message.state);
    })
    .catch((error: Error) => {
      missedCommands++;
      if (log) showToast(error.message || "Control command failed", true);
    });
}

function connect(): void {
  window.clearTimeout(reconnectTimer);
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  setConnected(false);
  setLinkStatus(connectionAttempts++ === 0 ? "Connecting" : "Reconnecting", "connecting");
  let current: WebSocket;
  try {
    current = new WebSocket(`${wsBase}/ws`);
    socket = current;
  } catch {
    scheduleReconnect();
    return;
  }
  current.addEventListener("open", () => {
    if (socket !== current) return;
    setConnected(true);
    addConnection("Control link connected", true);
    addLog("system", "Control link connected", wsBase);
    send("hello", { client: window.SubmarineAndroid ? "android" : "web", protocol: PROTOCOL_VERSION }, false);
    startHeartbeat();
    refreshStatus();
    refreshActiveCameraStream();
  });
  current.addEventListener("message", (event) => { if (socket === current) handleMessage(String(event.data)); });
  current.addEventListener("close", () => {
    if (socket !== current) return;
    setConnected(false);
    pilotToken = 0;
    setLinkStatus("Reconnecting", "connecting");
    addConnection("Control link disconnected", false);
    addLog("error", "Control link disconnected", "Automatic reconnect scheduled");
    stopHeartbeat();
    scheduleReconnect();
  });
  current.addEventListener("error", () => current.close());
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
    if (typeof message.pilotToken === "number") pilotToken = message.pilotToken;
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
  if (typeof incoming.frontBallastDeg !== "number" && typeof incoming.frontBallast === "number") incoming.frontBallastDeg = Math.round((1 - incoming.frontBallast) * 180);
  if (typeof incoming.rearBallastDeg !== "number" && typeof incoming.rearBallast === "number") incoming.rearBallastDeg = Math.round((1 - incoming.rearBallast) * 180);
  const cameraReadinessChanged = typeof incoming.cameraReady === "boolean" && incoming.cameraReady !== state.cameraReady;
  state = { ...state, ...incoming };
  if (incoming.pilot === false) pilotToken = 0;
  if (cameraReadinessChanged) refreshActiveCameraStream();
  if ((!state.armed || state.failsafe) && (motorInput.left !== 0 || motorInput.right !== 0)) neutralizeMotors(false);
  if (!ballastUiInitialized && typeof state.frontBallastDeg === "number" && typeof state.rearBallastDeg === "number") {
    const master = Math.round((state.frontBallastDeg + state.rearBallastDeg) / 2);
    setBallastControls(master, clamp(Math.round(state.frontBallastDeg - master), -30, 30), clamp(Math.round(state.rearBallastDeg - master), -30, 30), false);
    ballastUiInitialized = true;
  }
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

function describeMotor(value: number): string {
  if (Math.abs(value) < .03) return "Neutral";
  return `${value > 0 ? "Forward" : "Reverse"} ${Math.round(Math.abs(value) * 100)}%`;
}

function motorElement(side: "left" | "right"): HTMLInputElement {
  return $(`${side}Throttle`) as HTMLInputElement;
}

function renderMotorInputs(): void {
  (["left", "right"] as const).forEach((side) => {
    const input = motorElement(side);
    input.value = String(Math.round(motorInput[side] * 100));
    setRangeFill(input);
  });
  const levels = directMotorLevels(motorInput.left, motorInput.right, Number(($("throttleLimit") as HTMLInputElement).value) / 100);
  state.leftMotor = levels.left;
  state.rightMotor = levels.right;
  $("leftMotor").textContent = describeMotor(levels.left);
  $("rightMotor").textContent = describeMotor(levels.right);
}

function sendMotorCommand(log = false): void {
  if (!state.armed) return;
  const limit = Number(($("throttleLimit") as HTMLInputElement).value) / 100;
  sendActuator("motors", { left: motorInput.left, right: motorInput.right, limit }, log);
}

function queueMotorCommand(): void {
  renderMotorInputs();
  if (motorSendTimer) return;
  motorSendTimer = window.setTimeout(() => {
    sendMotorCommand(false);
    motorSendTimer = 0;
  }, 60);
}

function setMotorInput(side: "left" | "right", value: number): void {
  motorInput[side] = clamp(value, -1, 1);
  queueMotorCommand();
}

function releaseMotor(side: "left" | "right"): void {
  window.clearTimeout(motorSendTimer);
  motorSendTimer = 0;
  motorInput[side] = 0;
  renderMotorInputs();
  sendMotorCommand(false);
}

function neutralizeMotors(sendStop = true, log = false): void {
  window.clearTimeout(motorSendTimer);
  motorSendTimer = 0;
  motorInput = { left: 0, right: 0 };
  renderMotorInputs();
  if (sendStop && state.armed) sendActuator("motors", { left: 0, right: 0, limit: 1 }, log);
}

function signedDegrees(value: number): string {
  return `${value > 0 ? "+" : ""}${value}°`;
}

function currentBallastAngles() {
  const master = Number(($("masterBallast") as HTMLInputElement).value);
  const frontTrim = Number(($("frontTrim") as HTMLInputElement).value);
  const rearTrim = Number(($("rearTrim") as HTMLInputElement).value);
  return { master, frontTrim, rearTrim, ...effectiveBallastAngles(master, frontTrim, rearTrim) };
}

function renderBallastControls(): void {
  const angles = currentBallastAngles();
  $("masterBallastOutput").textContent = `${angles.master}°`;
  $("frontTrimOutput").textContent = signedDegrees(angles.frontTrim);
  $("rearTrimOutput").textContent = signedDegrees(angles.rearTrim);
  $("frontBallastOutput").textContent = `${angles.front}°`;
  $("rearBallastOutput").textContent = `${angles.rear}°`;
  ["masterBallast", "frontTrim", "rearTrim"].forEach((id) => setRangeFill($(id) as HTMLInputElement));
  state.frontBallastDeg = angles.front;
  state.rearBallastDeg = angles.rear;
  state.frontBallast = 1 - angles.front / 180;
  state.rearBallast = 1 - angles.rear / 180;
  $("ballastState").textContent = angles.master === 0 ? "0° Dive" : angles.master === 180 ? "180° Surface" : `${angles.master}° Hold`;
}

function sendBallastCommand(mode = "", log = false): void {
  const { front, rear } = currentBallastAngles();
  sendActuator("ballast_angle", { frontDeg: front, rearDeg: rear, ...(mode ? { mode } : {}) }, log);
}

function queueBallastCommand(): void {
  renderBallastControls();
  if (ballastSendTimer) return;
  ballastSendTimer = window.setTimeout(() => {
    sendBallastCommand();
    ballastSendTimer = 0;
  }, 80);
}

function setBallastControls(master: number, frontTrim: number, rearTrim: number, sendCommand = true, mode = ""): void {
  ($("masterBallast") as HTMLInputElement).value = String(Math.round(clamp(master, 0, 180)));
  ($("frontTrim") as HTMLInputElement).value = String(Math.round(clamp(frontTrim, -30, 30)));
  ($("rearTrim") as HTMLInputElement).value = String(Math.round(clamp(rearTrim, -30, 30)));
  renderBallastControls();
  if (sendCommand) sendBallastCommand(mode, true);
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
  sendActuator("light", { value: safe / 100 }, false);
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
  const escValid = values.slice(0, 3).every(validPulse) && values[0] < values[1] && values[1] < values[2];
  const servoValid = values.slice(3).every((value) => Number.isInteger(value) && value >= 500 && value <= 2500);
  if (!escValid || !servoValid) {
    showToast("Use ESC 800–2200 µs and servo 500–2500 µs values", true);
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
$("openWifiButton").addEventListener("click", () => window.SubmarineAndroid?.openWifiSettings());
$("refreshStatus").addEventListener("click", () => { refreshStatus(); showToast("Status refreshed"); });
$("claimButton").addEventListener("click", () => {
  if (state.pilot) neutralizeMotors();
  send(state.pilot ? "release" : "claim");
});
$("armButton").addEventListener("click", () => {
  if (state.armed) neutralizeMotors();
  send("arm", { armed: !state.armed });
});

(["left", "right"] as const).forEach((side) => {
  const input = motorElement(side);
  input.addEventListener("input", () => setMotorInput(side, Number(input.value) / 100));
  input.addEventListener("pointerup", () => releaseMotor(side));
  input.addEventListener("pointercancel", () => releaseMotor(side));
  input.addEventListener("lostpointercapture", () => { if (motorInput[side] !== 0) releaseMotor(side); });
  input.addEventListener("keyup", (event) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) releaseMotor(side);
  });
  input.addEventListener("blur", () => { if (motorInput[side] !== 0) releaseMotor(side); });
});
$("stopMotors").addEventListener("click", () => { neutralizeMotors(true, true); showToast("Both motors stopped"); });

document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => { setRangeFill(input); input.addEventListener("input", () => setRangeFill(input)); });
$("throttleLimit").addEventListener("input", () => { $("throttleOutput").textContent = `${($("throttleLimit") as HTMLInputElement).value}%`; queueMotorCommand(); });
["pilotLight", "cameraLight"].forEach((id) => $(id).addEventListener("input", () => setLight(Number(($(id) as HTMLInputElement).value))));
["masterBallast", "frontTrim", "rearTrim"].forEach((id) => $(id).addEventListener("input", queueBallastCommand));
$("surfaceButton").addEventListener("click", () => setBallastControls(180, 0, 0, true, "surface"));
$("diveButton").addEventListener("click", () => setBallastControls(0, 0, 0, true, "dive"));
$("emergencyButton").addEventListener("click", () => emergencyDialog.showModal());
$("cancelEmergency").addEventListener("click", () => emergencyDialog.close());
$("confirmEmergency").addEventListener("click", () => { neutralizeMotors(false); setBallastControls(180, 0, 0, false); send("emergency_surface"); emergencyDialog.close(); });
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

window.addEventListener("beforeunload", () => { if (state.pilot) { neutralizeMotors(); send("release", {}, false); } stopHeartbeat(); });
window.addEventListener("blur", () => { if (state.armed) neutralizeMotors(); });
pilotFeed.addEventListener("error", () => $("feedFps").textContent = "STREAM WAITING");
cameraFeed.addEventListener("error", () => $("cameraFps").textContent = "STREAM WAITING");

$("snapshotCount").textContent = localStorage.getItem("subrc.snapshots") ?? "0";
$("recordingCount").textContent = localStorage.getItem("subrc.recordings") ?? "0";
renderLogs();
renderConnectionHistory();
renderMotorInputs();
renderBallastControls();
if (window.SubmarineAndroid) $("openWifiButton").hidden = false;
window.setTimeout(() => { boot.hidden = true; app.hidden = false; updateStateUI(); connect(); }, 400);
