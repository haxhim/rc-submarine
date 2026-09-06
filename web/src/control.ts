export const PROTOCOL_VERSION = 1;

export type DriveMix = { left: number; right: number };

export function clamp(value: number, min = -1, max = 1): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

export function mixDrive(surge: number, yaw: number, limit = 1): DriveMix {
  const safeLimit = clamp(limit, 0, 1);
  const left = clamp(surge + yaw) * safeLimit;
  const right = clamp(surge - yaw) * safeLimit;
  return { left: Number(left.toFixed(3)), right: Number(right.toFixed(3)) };
}

export function normalizedToPulse(
  value: number,
  minUs: number,
  neutralUs: number,
  maxUs: number,
): number {
  const safe = clamp(value);
  const pulse = safe >= 0
    ? neutralUs + safe * (maxUs - neutralUs)
    : neutralUs + safe * (neutralUs - minUs);
  return Math.round(clamp(pulse, minUs, maxUs));
}

export function validPulse(value: number): boolean {
  return Number.isInteger(value) && value >= 800 && value <= 2200;
}

export function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
