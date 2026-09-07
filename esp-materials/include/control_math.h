#pragma once
#include <Arduino.h>

struct MotorMix { float left; float right; };

inline float clampUnit(float value) {
  return value < -1.0f ? -1.0f : value > 1.0f ? 1.0f : value;
}

inline float clamp01(float value) {
  return value < 0.0f ? 0.0f : value > 1.0f ? 1.0f : value;
}

inline MotorMix differentialMix(float surge, float yaw, float limit) {
  const float safeLimit = clamp01(limit);
  return { clampUnit(surge + yaw) * safeLimit, clampUnit(surge - yaw) * safeLimit };
}

inline MotorMix directMotorLevels(float left, float right, float limit) {
  const float safeLimit = clamp01(limit);
  return { clampUnit(left) * safeLimit, clampUnit(right) * safeLimit };
}

inline uint16_t normalizedPulse(float value, uint16_t minimum, uint16_t neutral, uint16_t maximum) {
  const float safe = clampUnit(value);
  return safe >= 0.0f
    ? static_cast<uint16_t>(neutral + (maximum - neutral) * safe)
    : static_cast<uint16_t>(neutral + (neutral - minimum) * safe);
}

inline uint16_t endpointPulse(float amount, uint16_t surface, uint16_t dive, bool inverted) {
  const float safe = clamp01(inverted ? 1.0f - amount : amount);
  return static_cast<uint16_t>(surface + (dive - surface) * safe);
}

inline uint16_t ballastAnglePulse(float angle, uint16_t surface, uint16_t dive, bool inverted) {
  float amount = angle < 0.0f ? 0.0f : angle > 180.0f ? 1.0f : angle / 180.0f;
  if (inverted) amount = 1.0f - amount;
  return static_cast<uint16_t>(dive + (surface - dive) * amount);
}

inline bool validBallastAngle(float angle) { return angle >= 0.0f && angle <= 180.0f; }

inline bool validPulse(uint16_t pulse) { return pulse >= 800 && pulse <= 2200; }
