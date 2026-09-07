#include <Arduino.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <ESP32Servo.h>
#include <memory>
#include "esp_camera.h"
#include "esp_http_server.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "control_math.h"
#include "pins.h"

constexpr char FIRMWARE_VERSION[] = "1.3.0";
constexpr char DEFAULT_AP_PASSWORD[] = "NautilusRC!";
constexpr uint8_t PROTOCOL_VERSION = 1;
constexpr uint32_t DEFAULT_FAILSAFE_MS = 1000;
constexpr uint32_t PWM_PERIOD_US = 20000;

struct Calibration {
  uint16_t escMin = 1000;
  uint16_t escNeutral = 1500;
  uint16_t escMax = 2000;
  uint16_t frontSurface = 2500;
  uint16_t frontDive = 500;
  uint16_t rearSurface = 2500;
  uint16_t rearDive = 500;
  bool invertLeft = false;
  bool invertRight = false;
  bool invertFront = false;
  bool invertRear = false;
  bool valid = false;
};

Preferences preferences;
Calibration calibration;
httpd_handle_t controlServer = nullptr;
WiFiServer mjpegServer(81);
SemaphoreHandle_t stateMutex;
Servo leftEsc;
Servo rightEsc;
Servo frontServo;
Servo rearServo;

volatile bool armed = false;
volatile bool failsafe = false;
volatile int pilotFd = -1;
volatile uint32_t pilotToken = 0;
volatile uint32_t lastActuatorSeq = 0;
volatile uint32_t lastHeartbeat = 0;
uint32_t failsafeMs = DEFAULT_FAILSAFE_MS;
float frontBallast = 0;
float rearBallast = 0;
float frontBallastDeg = 180;
float rearBallastDeg = 180;
float leftMotor = 0;
float rightMotor = 0;
float lightLevel = 0;
String frameSizeName = "QVGA";
uint8_t jpegQuality = 12;
volatile float streamFps = 0;
bool cameraReady = false;
bool ballastOutputsAttached = false;
String apPassword = DEFAULT_AP_PASSWORD;
String apSsid;

void writePulse(int channel, uint16_t pulseUs) {
  if (channel == LEFT_ESC_CHANNEL) leftEsc.writeMicroseconds(pulseUs);
  else if (channel == RIGHT_ESC_CHANNEL) rightEsc.writeMicroseconds(pulseUs);
  else if (channel == FRONT_SERVO_CHANNEL && ballastOutputsAttached) frontServo.writeMicroseconds(pulseUs);
  else if (channel == REAR_SERVO_CHANNEL && ballastOutputsAttached) rearServo.writeMicroseconds(pulseUs);
}

void neutralizePropulsion() {
  leftMotor = 0;
  rightMotor = 0;
  writePulse(LEFT_ESC_CHANNEL, calibration.escNeutral);
  writePulse(RIGHT_ESC_CHANNEL, calibration.escNeutral);
}

void setBallast(float front, float rear) {
  if (!calibration.valid) return;
  frontBallast = clamp01(front);
  rearBallast = clamp01(rear);
  frontBallastDeg = (1.0f - frontBallast) * 180.0f;
  rearBallastDeg = (1.0f - rearBallast) * 180.0f;
  writePulse(FRONT_SERVO_CHANNEL, endpointPulse(frontBallast, calibration.frontSurface, calibration.frontDive, calibration.invertFront));
  writePulse(REAR_SERVO_CHANNEL, endpointPulse(rearBallast, calibration.rearSurface, calibration.rearDive, calibration.invertRear));
}

void setBallastAngle(float frontDeg, float rearDeg) {
  if (!calibration.valid) return;
  frontBallastDeg = frontDeg < 0.0f ? 0.0f : frontDeg > 180.0f ? 180.0f : frontDeg;
  rearBallastDeg = rearDeg < 0.0f ? 0.0f : rearDeg > 180.0f ? 180.0f : rearDeg;
  frontBallast = 1.0f - frontBallastDeg / 180.0f;
  rearBallast = 1.0f - rearBallastDeg / 180.0f;
  writePulse(FRONT_SERVO_CHANNEL, ballastAnglePulse(frontBallastDeg, calibration.frontSurface, calibration.frontDive, calibration.invertFront));
  writePulse(REAR_SERVO_CHANNEL, ballastAnglePulse(rearBallastDeg, calibration.rearSurface, calibration.rearDive, calibration.invertRear));
}

void attachBallastOutputs() {
  if (ballastOutputsAttached) return;
  frontServo.setPeriodHertz(50);
  rearServo.setPeriodHertz(50);
  frontServo.attach(FRONT_BALLAST_PIN, 500, 2500);
  rearServo.attach(REAR_BALLAST_PIN, 500, 2500);
  ballastOutputsAttached = true;
}

void safeSurface(bool markFailsafe) {
  armed = false;
  neutralizePropulsion();
  if (calibration.valid) setBallastAngle(180, 180);
  failsafe = markFailsafe;
}

bool loadSettings() {
  preferences.begin("subrc", true);
  calibration.valid = preferences.getBool("cal_valid", false);
  calibration.escMin = preferences.getUShort("esc_min", 1000);
  calibration.escNeutral = preferences.getUShort("esc_neu", 1500);
  calibration.escMax = preferences.getUShort("esc_max", 2000);
  calibration.frontSurface = preferences.getUShort("front_s", 2500);
  calibration.frontDive = preferences.getUShort("front_d", 500);
  calibration.rearSurface = preferences.getUShort("rear_s", 2500);
  calibration.rearDive = preferences.getUShort("rear_d", 500);
  calibration.invertLeft = preferences.getBool("inv_left", false);
  calibration.invertRight = preferences.getBool("inv_right", false);
  calibration.invertFront = preferences.getBool("inv_front", false);
  calibration.invertRear = preferences.getBool("inv_rear", false);
  failsafeMs = preferences.getUInt("failsafe", DEFAULT_FAILSAFE_MS);
  apPassword = preferences.getString("ap_pass", DEFAULT_AP_PASSWORD);
  frameSizeName = preferences.getString("frame", "QVGA");
  jpegQuality = preferences.getUChar("quality", 12);
  preferences.end();
  const bool pulsesValid = validPulse(calibration.escMin) && validPulse(calibration.escNeutral) && validPulse(calibration.escMax)
    && calibration.escMin < calibration.escNeutral && calibration.escNeutral < calibration.escMax
    && calibration.frontSurface >= 500 && calibration.frontSurface <= 2500
    && calibration.frontDive >= 500 && calibration.frontDive <= 2500
    && calibration.rearSurface >= 500 && calibration.rearSurface <= 2500
    && calibration.rearDive >= 500 && calibration.rearDive <= 2500;
  if (!calibration.valid || !pulsesValid) calibration = Calibration{};
  if (!(failsafeMs == 750 || failsafeMs == 1000 || failsafeMs == 1500)) failsafeMs = DEFAULT_FAILSAFE_MS;
  if (!(frameSizeName == "QVGA" || frameSizeName == "VGA" || frameSizeName == "SVGA")) frameSizeName = "QVGA";
  if (jpegQuality < 8 || jpegQuality > 30) jpegQuality = 12;
  if (apPassword.length() < 8 || apPassword.length() > 63) apPassword = DEFAULT_AP_PASSWORD;
  return calibration.valid;
}

void saveCalibration() {
  preferences.begin("subrc", false);
  preferences.putBool("cal_valid", calibration.valid);
  preferences.putUShort("esc_min", calibration.escMin);
  preferences.putUShort("esc_neu", calibration.escNeutral);
  preferences.putUShort("esc_max", calibration.escMax);
  preferences.putUShort("front_s", calibration.frontSurface);
  preferences.putUShort("front_d", calibration.frontDive);
  preferences.putUShort("rear_s", calibration.rearSurface);
  preferences.putUShort("rear_d", calibration.rearDive);
  preferences.putBool("inv_left", calibration.invertLeft);
  preferences.putBool("inv_right", calibration.invertRight);
  preferences.putBool("inv_front", calibration.invertFront);
  preferences.putBool("inv_rear", calibration.invertRear);
  preferences.end();
}

framesize_t frameSizeFromName(const String &name) {
  if (name == "QVGA") return FRAMESIZE_QVGA;
  if (name == "SVGA") return FRAMESIZE_SVGA;
  return FRAMESIZE_VGA;
}

void fillState(JsonObject output, int forFd = -1) {
  output["calibrated"] = calibration.valid;
  output["armed"] = armed;
  output["pilot"] = forFd >= 0 ? pilotFd == forFd : pilotFd >= 0;
  output["failsafe"] = failsafe;
  wifi_sta_list_t stations = {};
  if (esp_wifi_ap_get_sta_list(&stations) == ESP_OK && stations.num > 0) output["rssi"] = stations.sta[0].rssi;
  else output["rssi"] = nullptr;
  output["uptimeMs"] = millis();
  output["clients"] = WiFi.softAPgetStationNum();
  output["firmware"] = FIRMWARE_VERSION;
  output["light"] = lightLevel;
  output["frontBallast"] = frontBallast;
  output["rearBallast"] = rearBallast;
  output["frontBallastDeg"] = frontBallastDeg;
  output["rearBallastDeg"] = rearBallastDeg;
  output["leftMotor"] = leftMotor;
  output["rightMotor"] = rightMotor;
  output["frameSize"] = frameSizeName;
  output["jpegQuality"] = jpegQuality;
  output["streamFps"] = streamFps;
  output["cameraReady"] = cameraReady;
  if (calibration.valid) {
    JsonObject saved = output["calibration"].to<JsonObject>();
    saved["escMin"] = calibration.escMin; saved["escNeutral"] = calibration.escNeutral; saved["escMax"] = calibration.escMax;
    saved["frontSurface"] = calibration.frontSurface; saved["frontDive"] = calibration.frontDive;
    saved["rearSurface"] = calibration.rearSurface; saved["rearDive"] = calibration.rearDive;
    saved["invertLeft"] = calibration.invertLeft; saved["invertRight"] = calibration.invertRight;
    saved["invertFront"] = calibration.invertFront; saved["invertRear"] = calibration.invertRear;
  }
}

esp_err_t sendJson(httpd_req_t *req, JsonDocument &document, int status = 200) {
  String body;
  serializeJson(document, body);
  httpd_resp_set_status(req, status == 200 ? "200 OK" : "400 Bad Request");
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, body.c_str(), body.length());
}

esp_err_t sendWs(httpd_req_t *req, JsonDocument &document) {
  String body;
  serializeJson(document, body);
  httpd_ws_frame_t response = {};
  response.type = HTTPD_WS_TYPE_TEXT;
  response.payload = reinterpret_cast<uint8_t *>(const_cast<char *>(body.c_str()));
  response.len = body.length();
  return httpd_ws_send_frame(req, &response);
}

esp_err_t sendAck(httpd_req_t *req, JsonVariantConst request, bool ok, const char *message = "") {
  JsonDocument response;
  response["v"] = PROTOCOL_VERSION;
  response["type"] = "ack";
  response["seq"] = request["seq"] | 0;
  response["ok"] = ok;
  if (message[0]) response["message"] = message;
  if (pilotFd == httpd_req_to_sockfd(req) && pilotToken != 0) response["pilotToken"] = pilotToken;
  JsonObject state = response["state"].to<JsonObject>();
  fillState(state, httpd_req_to_sockfd(req));
  return sendWs(req, response);
}

bool requirePilot(httpd_req_t *req, JsonVariantConst request) {
  if (pilotFd == httpd_req_to_sockfd(req)) return true;
  sendAck(req, request, false, "Active pilot control is required");
  return false;
}

bool jsonUnit(JsonVariantConst value) {
  return value.is<float>() && value.as<float>() >= -1.0f && value.as<float>() <= 1.0f;
}

esp_err_t wsHandler(httpd_req_t *req) {
  if (req->method == HTTP_GET) return ESP_OK;
  httpd_ws_frame_t frame = {};
  frame.type = HTTPD_WS_TYPE_TEXT;
  esp_err_t result = httpd_ws_recv_frame(req, &frame, 0);
  if (result != ESP_OK || frame.len == 0 || frame.len > 2048) return ESP_FAIL;
  std::unique_ptr<uint8_t[]> payload(new uint8_t[frame.len + 1]);
  frame.payload = payload.get();
  result = httpd_ws_recv_frame(req, &frame, frame.len);
  if (result != ESP_OK) return result;
  payload[frame.len] = 0;

  JsonDocument requestDoc;
  if (deserializeJson(requestDoc, payload.get()) || requestDoc["v"].as<uint8_t>() != PROTOCOL_VERSION || !requestDoc["type"].is<const char *>()) {
    return sendAck(req, requestDoc.as<JsonVariantConst>(), false, "Invalid protocol packet");
  }
  JsonVariantConst request = requestDoc.as<JsonVariantConst>();
  const String type = request["type"].as<String>();
  const int fd = httpd_req_to_sockfd(req);

  if (type == "hello") return sendAck(req, request, true, "RC-01 ready");
  if (type == "heartbeat") {
    if (pilotFd == fd) lastHeartbeat = millis();
    return sendAck(req, request, true);
  }
  if (type == "claim") {
    if (pilotFd >= 0 && pilotFd != fd) return sendAck(req, request, false, "Another controller is the active pilot");
    pilotFd = fd;
    do { pilotToken = esp_random(); } while (pilotToken == 0);
    lastActuatorSeq = 0;
    lastHeartbeat = millis();
    failsafe = false;
    return sendAck(req, request, true, "Pilot control granted");
  }
  if (type == "release") {
    if (pilotFd == fd) { safeSurface(false); pilotFd = -1; pilotToken = 0; }
    return sendAck(req, request, true, "Pilot control released");
  }
  if (type == "arm") {
    if (!requirePilot(req, request)) return ESP_OK;
    if (!calibration.valid) return sendAck(req, request, false, "Calibration is required before arming");
    armed = request["armed"] | false;
    if (!armed) neutralizePropulsion();
    failsafe = false;
    return sendAck(req, request, true, armed ? "Propulsion armed" : "Propulsion disarmed");
  }
  if (type == "drive") {
    if (!requirePilot(req, request)) return ESP_OK;
    if (!armed) return sendAck(req, request, false, "Propulsion is disarmed");
    if (!jsonUnit(request["surge"]) || !jsonUnit(request["yaw"]) || !jsonUnit(request["limit"]) || request["limit"].as<float>() < 0) return sendAck(req, request, false, "Drive values must be normalized");
    MotorMix mix = differentialMix(request["surge"], request["yaw"], request["limit"]);
    if (calibration.invertLeft) mix.left *= -1;
    if (calibration.invertRight) mix.right *= -1;
    leftMotor = mix.left;
    rightMotor = mix.right;
    writePulse(LEFT_ESC_CHANNEL, normalizedPulse(mix.left, calibration.escMin, calibration.escNeutral, calibration.escMax));
    writePulse(RIGHT_ESC_CHANNEL, normalizedPulse(mix.right, calibration.escMin, calibration.escNeutral, calibration.escMax));
    return sendAck(req, request, true);
  }
  if (type == "motors") {
    if (!requirePilot(req, request)) return ESP_OK;
    if (!armed) return sendAck(req, request, false, "Propulsion is disarmed");
    if (!jsonUnit(request["left"]) || !jsonUnit(request["right"]) || !jsonUnit(request["limit"]) || request["limit"].as<float>() < 0) return sendAck(req, request, false, "Motor values must be normalized");
    MotorMix levels = directMotorLevels(request["left"], request["right"], request["limit"]);
    if (calibration.invertLeft) levels.left *= -1;
    if (calibration.invertRight) levels.right *= -1;
    leftMotor = levels.left;
    rightMotor = levels.right;
    writePulse(LEFT_ESC_CHANNEL, normalizedPulse(levels.left, calibration.escMin, calibration.escNeutral, calibration.escMax));
    writePulse(RIGHT_ESC_CHANNEL, normalizedPulse(levels.right, calibration.escMin, calibration.escNeutral, calibration.escMax));
    return sendAck(req, request, true);
  }
  if (type == "ballast") {
    if (!requirePilot(req, request)) return ESP_OK;
    if (!calibration.valid || !jsonUnit(request["front"]) || !jsonUnit(request["rear"]) || request["front"].as<float>() < 0 || request["rear"].as<float>() < 0) return sendAck(req, request, false, "Ballast values must be between 0 and 1");
    setBallast(request["front"], request["rear"]);
    return sendAck(req, request, true, request["mode"] == "surface" ? "Ballast moving to surface" : request["mode"] == "dive" ? "Ballast moving to dive" : "");
  }
  if (type == "ballast_angle") {
    if (!requirePilot(req, request)) return ESP_OK;
    if (!calibration.valid || !request["frontDeg"].is<int>() || !request["rearDeg"].is<int>() || !validBallastAngle(request["frontDeg"].as<float>()) || !validBallastAngle(request["rearDeg"].as<float>())) return sendAck(req, request, false, "Ballast angles must be whole degrees from 0 to 180");
    setBallastAngle(request["frontDeg"], request["rearDeg"]);
    return sendAck(req, request, true, request["mode"] == "surface" ? "Ballast moving to 180 degree surface position" : request["mode"] == "dive" ? "Ballast moving to 0 degree dive position" : "");
  }
  if (type == "light") {
    if (!requirePilot(req, request)) return ESP_OK;
    if (!jsonUnit(request["value"]) || request["value"].as<float>() < 0) return sendAck(req, request, false, "Light value must be between 0 and 1");
    lightLevel = request["value"];
    ledcWrite(LIGHT_CHANNEL, static_cast<uint8_t>(lightLevel * 255));
    return sendAck(req, request, true);
  }
  if (type == "camera") {
    if (!requirePilot(req, request)) return ESP_OK;
    const String size = request["frameSize"] | "";
    const int quality = request["quality"] | 0;
    if (!(size == "QVGA" || size == "VGA" || size == "SVGA") || quality < 8 || quality > 30) return sendAck(req, request, false, "Unsupported camera settings");
    sensor_t *sensor = esp_camera_sensor_get();
    if (!sensor || sensor->set_framesize(sensor, frameSizeFromName(size)) || sensor->set_quality(sensor, quality)) return sendAck(req, request, false, "Camera rejected settings");
    frameSizeName = size;
    jpegQuality = quality;
    preferences.begin("subrc", false); preferences.putString("frame", size); preferences.putUChar("quality", jpegQuality); preferences.end();
    return sendAck(req, request, true, "Camera settings applied");
  }
  if (type == "calibration") {
    if (!requirePilot(req, request)) return ESP_OK;
    const int values[] = { request["escMin"] | 0, request["escNeutral"] | 0, request["escMax"] | 0, request["frontSurface"] | 0, request["frontDive"] | 0, request["rearSurface"] | 0, request["rearDive"] | 0 };
    bool valuesValid = request["benchConfirmed"] == true && values[0] < values[1] && values[1] < values[2];
    for (int index = 0; index < 3; index++) valuesValid = valuesValid && values[index] >= 800 && values[index] <= 2200;
    for (int index = 3; index < 7; index++) valuesValid = valuesValid && values[index] >= 500 && values[index] <= 2500;
    if (!valuesValid) return sendAck(req, request, false, "Invalid or unsafe calibration values");
    safeSurface(false);
    calibration.escMin = values[0]; calibration.escNeutral = values[1]; calibration.escMax = values[2];
    calibration.frontSurface = values[3]; calibration.frontDive = values[4]; calibration.rearSurface = values[5]; calibration.rearDive = values[6];
    calibration.invertLeft = request["invertLeft"] | false; calibration.invertRight = request["invertRight"] | false;
    calibration.invertFront = request["invertFront"] | false; calibration.invertRear = request["invertRear"] | false;
    calibration.valid = true;
    saveCalibration();
    neutralizePropulsion();
    attachBallastOutputs();
    setBallastAngle(180, 180);
    return sendAck(req, request, true, "Calibration saved; propulsion remains disarmed");
  }
  if (type == "config") {
    if (!requirePilot(req, request)) return ESP_OK;
    if (!request["failsafeMs"].isNull()) {
      const uint32_t value = request["failsafeMs"];
      if (!(value == 750 || value == 1000 || value == 1500)) return sendAck(req, request, false, "Unsupported failsafe interval");
      failsafeMs = value;
      preferences.begin("subrc", false); preferences.putUInt("failsafe", failsafeMs); preferences.end();
    }
    if (!request["apPassword"].isNull()) {
      const String password = request["apPassword"];
      if (password.length() < 8 || password.length() > 63) return sendAck(req, request, false, "Wi-Fi password must contain 8 to 63 characters");
      apPassword = password;
      preferences.begin("subrc", false); preferences.putString("ap_pass", apPassword); preferences.end();
    }
    const bool restart = request["restart"] | false;
    sendAck(req, request, true, restart ? "Saved; controller restarting" : "Configuration saved");
    if (restart) { delay(250); ESP.restart(); }
    return ESP_OK;
  }
  if (type == "config_import") {
    if (!requirePilot(req, request)) return ESP_OK;
    JsonVariantConst imported = request["config"];
    if (imported["version"].as<int>() != 1) return sendAck(req, request, false, "Unsupported configuration file");
    const uint32_t importedFailsafe = imported["failsafeMs"] | failsafeMs;
    if (!(importedFailsafe == 750 || importedFailsafe == 1000 || importedFailsafe == 1500)) return sendAck(req, request, false, "Imported failsafe value is invalid");
    const String importedFrame = imported["frameSize"] | frameSizeName;
    const int importedQuality = imported["jpegQuality"] | jpegQuality;
    if (!(importedFrame == "QVGA" || importedFrame == "VGA" || importedFrame == "SVGA") || importedQuality < 8 || importedQuality > 30) return sendAck(req, request, false, "Imported camera settings are invalid");

    JsonVariantConst importedCalibration = imported["calibration"];
    if (!importedCalibration.isNull()) {
      const int values[] = { importedCalibration["escMin"] | 0, importedCalibration["escNeutral"] | 0, importedCalibration["escMax"] | 0, importedCalibration["frontSurface"] | 0, importedCalibration["frontDive"] | 0, importedCalibration["rearSurface"] | 0, importedCalibration["rearDive"] | 0 };
      bool valid = values[0] < values[1] && values[1] < values[2];
      for (int index = 0; index < 3; index++) valid = valid && values[index] >= 800 && values[index] <= 2200;
      for (int index = 3; index < 7; index++) valid = valid && values[index] >= 500 && values[index] <= 2500;
      if (!valid) return sendAck(req, request, false, "Imported calibration is invalid");
      safeSurface(false);
      calibration.escMin = values[0]; calibration.escNeutral = values[1]; calibration.escMax = values[2];
      calibration.frontSurface = values[3]; calibration.frontDive = values[4]; calibration.rearSurface = values[5]; calibration.rearDive = values[6];
      calibration.invertLeft = importedCalibration["invertLeft"] | false; calibration.invertRight = importedCalibration["invertRight"] | false;
      calibration.invertFront = importedCalibration["invertFront"] | false; calibration.invertRear = importedCalibration["invertRear"] | false;
      calibration.valid = true;
      saveCalibration();
      attachBallastOutputs();
      setBallastAngle(180, 180);
    }
    failsafeMs = importedFailsafe;
    frameSizeName = importedFrame;
    jpegQuality = importedQuality;
    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor) { sensor->set_framesize(sensor, frameSizeFromName(frameSizeName)); sensor->set_quality(sensor, jpegQuality); }
    preferences.begin("subrc", false);
    preferences.putUInt("failsafe", failsafeMs); preferences.putString("frame", frameSizeName); preferences.putUChar("quality", jpegQuality);
    preferences.end();
    return sendAck(req, request, true, "Configuration imported and saved");
  }
  if (type == "emergency_surface") {
    if (!requirePilot(req, request)) return ESP_OK;
    safeSurface(false);
    return sendAck(req, request, true, "Emergency surface activated");
  }
  return sendAck(req, request, false, "Unknown command type");
}

esp_err_t statusHandler(httpd_req_t *req) {
  JsonDocument document;
  fillState(document.to<JsonObject>());
  document.remove("pilot");
  return sendJson(req, document);
}

bool queryFloat(const char *query, const char *key, float &value) {
  char raw[24];
  if (httpd_query_key_value(query, key, raw, sizeof(raw)) != ESP_OK) return false;
  char *end = nullptr;
  value = strtof(raw, &end);
  return end != raw && *end == '\0';
}

bool queryUnsigned(const char *query, const char *key, uint32_t &value) {
  char raw[16];
  if (httpd_query_key_value(query, key, raw, sizeof(raw)) != ESP_OK) return false;
  char *end = nullptr;
  const unsigned long parsed = strtoul(raw, &end, 10);
  if (end == raw || *end != '\0') return false;
  value = static_cast<uint32_t>(parsed);
  return true;
}

// Lightweight actuator path based on the proven WebServer /set bench sketch.
// A random token binds requests to the single active WebSocket pilot.
esp_err_t setHandler(httpd_req_t *req) {
  char query[256] = {};
  if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing control values");
  uint32_t token = 0;
  uint32_t actuatorSeq = 0;
  if (pilotFd < 0 || pilotToken == 0 || !queryUnsigned(query, "token", token) || token != pilotToken) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Active pilot token required");
  if (!queryUnsigned(query, "seq", actuatorSeq) || actuatorSeq <= lastActuatorSeq) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Stale control sequence");
  if (!calibration.valid) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Calibration required");

  float value = 0.0f;
  float left = leftMotor;
  float right = rightMotor;
  float limit = 1.0f;
  const bool hasLeft = queryFloat(query, "left", left);
  const bool hasRight = queryFloat(query, "right", right);
  queryFloat(query, "limit", limit);
  if (hasLeft || hasRight) {
    if (!armed) return httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Propulsion is disarmed");
    if (left < -1.0f || left > 1.0f || right < -1.0f || right > 1.0f || limit < 0.0f || limit > 1.0f) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Motor values must be -1 to 1");
    MotorMix levels = directMotorLevels(left, right, limit);
    if (calibration.invertLeft) levels.left *= -1;
    if (calibration.invertRight) levels.right *= -1;
    leftMotor = levels.left;
    rightMotor = levels.right;
    writePulse(LEFT_ESC_CHANNEL, normalizedPulse(levels.left, calibration.escMin, calibration.escNeutral, calibration.escMax));
    writePulse(RIGHT_ESC_CHANNEL, normalizedPulse(levels.right, calibration.escMin, calibration.escNeutral, calibration.escMax));
  }

  float frontDeg = frontBallastDeg;
  float rearDeg = rearBallastDeg;
  const bool hasFront = queryFloat(query, "frontDeg", frontDeg);
  const bool hasRear = queryFloat(query, "rearDeg", rearDeg);
  if (hasFront || hasRear) {
    if (!validBallastAngle(frontDeg) || !validBallastAngle(rearDeg)) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Ballast must be 0 to 180 degrees");
    setBallastAngle(frontDeg, rearDeg);
  }

  if (queryFloat(query, "light", value)) {
    if (value < 0.0f || value > 1.0f) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Light must be 0 to 1");
    lightLevel = value;
    ledcWrite(LIGHT_CHANNEL, static_cast<uint8_t>(lightLevel * 255.0f));
  }

  lastActuatorSeq = actuatorSeq;
  JsonDocument document;
  document["ok"] = true;
  JsonObject current = document["state"].to<JsonObject>();
  fillState(current, pilotFd);
  return sendJson(req, document);
}

esp_err_t captureHandler(httpd_req_t *req) {
  if (!cameraReady) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Camera is not initialized");
  camera_fb_t *frame = esp_camera_fb_get();
  if (!frame) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Camera capture failed");
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=submarine.jpg");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  esp_err_t result = httpd_resp_send(req, reinterpret_cast<const char *>(frame->buf), frame->len);
  esp_camera_fb_return(frame);
  return result;
}

esp_err_t streamRedirectHandler(httpd_req_t *req) {
  httpd_resp_set_status(req, "302 Found");
  httpd_resp_set_hdr(req, "Location", "http://192.168.4.1:81/stream");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  return httpd_resp_send(req, nullptr, 0);
}

esp_err_t streamHandler(httpd_req_t *req) {
  if (!cameraReady) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Camera is not initialized");
  static const char *contentType = "multipart/x-mixed-replace;boundary=frame";
  static const char *boundary = "\r\n--frame\r\n";
  httpd_resp_set_type(req, contentType);
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  uint32_t frames = 0;
  uint32_t fpsStarted = millis();
  while (true) {
    camera_fb_t *frame = esp_camera_fb_get();
    if (!frame) return ESP_FAIL;
    char header[96];
    const int headerLength = snprintf(header, sizeof(header), "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", frame->len);
    esp_err_t result = httpd_resp_send_chunk(req, boundary, strlen(boundary));
    if (result == ESP_OK) result = httpd_resp_send_chunk(req, header, headerLength);
    if (result == ESP_OK) result = httpd_resp_send_chunk(req, reinterpret_cast<const char *>(frame->buf), frame->len);
    esp_camera_fb_return(frame);
    if (result != ESP_OK) break;
    frames++;
    const uint32_t elapsed = millis() - fpsStarted;
    if (elapsed >= 1000) { streamFps = (frames * 1000.0f) / elapsed; frames = 0; fpsStarted = millis(); }
    delay(1);
  }
  streamFps = 0;
  return ESP_OK;
}

void streamCameraClient(WiFiClient client) {
  client.setNoDelay(true);
  const uint32_t requestDeadline = millis() + 2000;
  while (client.connected() && !client.available() && static_cast<int32_t>(requestDeadline - millis()) > 0) delay(1);
  if (!client.connected() || !client.available()) { client.stop(); return; }
  while (client.available()) client.read();

  client.print(
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
    "Cache-Control: no-cache, no-store, must-revalidate\r\n"
    "Pragma: no-cache\r\n"
    "Access-Control-Allow-Origin: *\r\n"
    "Connection: close\r\n\r\n"
  );

  uint32_t frames = 0;
  uint32_t fpsStarted = millis();
  Serial.println("Camera client connected");
  while (client.connected() && cameraReady) {
    camera_fb_t *frame = esp_camera_fb_get();
    if (!frame) break;
    client.printf("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", frame->len);
    size_t sent = 0;
    while (sent < frame->len && client.connected()) {
      const size_t chunk = min(static_cast<size_t>(1460), frame->len - sent);
      const size_t written = client.write(frame->buf + sent, chunk);
      if (written == 0) break;
      sent += written;
    }
    esp_camera_fb_return(frame);
    if (sent == 0 || !client.connected()) break;
    client.print("\r\n");
    frames++;
    const uint32_t elapsed = millis() - fpsStarted;
    if (elapsed >= 1000) { streamFps = frames * 1000.0f / elapsed; frames = 0; fpsStarted = millis(); }
    delay(1);
  }
  streamFps = 0;
  client.stop();
  Serial.println("Camera client disconnected");
}

void cameraStreamTask(void *) {
  for (;;) {
    WiFiClient client = mjpegServer.available();
    if (client) streamCameraClient(client);
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

String contentTypeFor(const String &path) {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

esp_err_t staticHandler(httpd_req_t *req) {
  String path = req->uri;
  const int query = path.indexOf('?');
  if (query >= 0) path = path.substring(0, query);
  if (path == "/") path = "/index.html";
  if (path.indexOf("..") >= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid path");
  File file = LittleFS.open(path, "r");
  if (!file) return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Not found");
  httpd_resp_set_type(req, contentTypeFor(path).c_str());
  httpd_resp_set_hdr(req, "Cache-Control", path == "/index.html" ? "no-store" : "public, max-age=300");
  char buffer[1024];
  while (file.available()) {
    const size_t read = file.readBytes(buffer, sizeof(buffer));
    if (httpd_resp_send_chunk(req, buffer, read) != ESP_OK) { file.close(); return ESP_FAIL; }
  }
  file.close();
  return httpd_resp_send_chunk(req, nullptr, 0);
}

bool initializeCamera() {
  camera_config_t config = {};
  const bool hasPsram = psramFound();
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM; config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM; config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM; config.pin_pclk = PCLK_GPIO_NUM; config.pin_vsync = VSYNC_GPIO_NUM; config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM; config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM; config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  // Bench-proven low-latency startup profile from the working demo sketch.
  config.frame_size = hasPsram ? FRAMESIZE_QVGA : FRAMESIZE_QQVGA;
  config.jpeg_quality = hasPsram ? 12 : 14;
  config.fb_count = hasPsram ? 2 : 1;
  config.grab_mode = hasPsram ? CAMERA_GRAB_LATEST : CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = hasPsram ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  frameSizeName = hasPsram ? "QVGA" : "QQVGA";
  jpegQuality = config.jpeg_quality;
  Serial.printf("Camera init: PSRAM %s, frame %s, quality %u\n", hasPsram ? "available" : "not found", frameSizeName.c_str(), jpegQuality);
  const esp_err_t error = esp_camera_init(&config);
  if (error != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", error);
    cameraReady = false;
    return false;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor) {
    sensor->set_framesize(sensor, hasPsram ? FRAMESIZE_QVGA : FRAMESIZE_QQVGA);
    sensor->set_quality(sensor, jpegQuality);
    sensor->set_hmirror(sensor, 0);
    sensor->set_vflip(sensor, 0);
    sensor->set_brightness(sensor, 0);
    sensor->set_contrast(sensor, 0);
    sensor->set_saturation(sensor, 0);
  }
  cameraReady = true;
  Serial.println("Camera initialized successfully");
  return true;
}

void startServers() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.max_uri_handlers = 9;
  config.uri_match_fn = httpd_uri_match_wildcard;
  httpd_start(&controlServer, &config);
  httpd_uri_t ws = { .uri = "/ws", .method = HTTP_GET, .handler = wsHandler, .user_ctx = nullptr, .is_websocket = true };
  httpd_uri_t status = { .uri = "/api/status", .method = HTTP_GET, .handler = statusHandler, .user_ctx = nullptr };
  httpd_uri_t capture = { .uri = "/capture", .method = HTTP_GET, .handler = captureHandler, .user_ctx = nullptr };
  httpd_uri_t set = { .uri = "/set", .method = HTTP_GET, .handler = setHandler, .user_ctx = nullptr };
  httpd_uri_t redirect = { .uri = "/stream", .method = HTTP_GET, .handler = streamRedirectHandler, .user_ctx = nullptr };
  httpd_uri_t files = { .uri = "/*", .method = HTTP_GET, .handler = staticHandler, .user_ctx = nullptr };
  httpd_register_uri_handler(controlServer, &ws);
  httpd_register_uri_handler(controlServer, &status);
  httpd_register_uri_handler(controlServer, &capture);
  httpd_register_uri_handler(controlServer, &set);
  httpd_register_uri_handler(controlServer, &redirect);
  httpd_register_uri_handler(controlServer, &files);

  mjpegServer.begin();
  mjpegServer.setNoDelay(true);
  xTaskCreatePinnedToCore(cameraStreamTask, "mjpeg", 8192, nullptr, 1, nullptr, 0);
}

void setup() {
  Serial.begin(115200);
  stateMutex = xSemaphoreCreateMutex();
  loadSettings();

  // Keep timer 0 free for the OV2640 XCLK and timer 3 for the flash LED.
  // All four 50 Hz ESC/servo outputs share LEDC timer 1.
  ESP32PWM::allocateTimer(1);
  leftEsc.setPeriodHertz(50);
  rightEsc.setPeriodHertz(50);
  leftEsc.attach(LEFT_ESC_PIN, 1000, 2000);
  rightEsc.attach(RIGHT_ESC_PIN, 1000, 2000);
  neutralizePropulsion();
  ledcSetup(LIGHT_CHANNEL, 5000, 8); ledcAttachPin(LIGHT_PIN, LIGHT_CHANNEL); ledcWrite(LIGHT_CHANNEL, 0);
  if (calibration.valid) {
    attachBallastOutputs();
    setBallastAngle(180, 180);
  }

  if (!LittleFS.begin(true)) Serial.println("LittleFS mount failed");
  initializeCamera();

  const uint64_t chipId = ESP.getEfuseMac();
  char suffix[7];
  snprintf(suffix, sizeof(suffix), "%06llX", chipId & 0xFFFFFFULL);
  apSsid = "SUB-RC-" + String(suffix);
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  WiFi.softAP(apSsid.c_str(), apPassword.c_str(), 6, false, 2);
  startServers();
  Serial.printf("\n%s ready at http://192.168.4.1\n", apSsid.c_str());
}

void loop() {
  if (pilotFd >= 0 && millis() - lastHeartbeat > failsafeMs) {
    safeSurface(true);
    pilotFd = -1;
    pilotToken = 0;
    lastActuatorSeq = 0;
    Serial.println("FAILSAFE: heartbeat timeout; surfaced");
  }
  delay(10);
}
