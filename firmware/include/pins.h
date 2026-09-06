#pragma once

// AI-Thinker ESP32-CAM + OV2640 camera mapping.
#define PWDN_GPIO_NUM   32
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM    0
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define Y9_GPIO_NUM     35
#define Y8_GPIO_NUM     34
#define Y7_GPIO_NUM     39
#define Y6_GPIO_NUM     36
#define Y5_GPIO_NUM     21
#define Y4_GPIO_NUM     19
#define Y3_GPIO_NUM     18
#define Y2_GPIO_NUM      5
#define VSYNC_GPIO_NUM  25
#define HREF_GPIO_NUM   23
#define PCLK_GPIO_NUM   22

// Control outputs. GPIO16 is intentionally unused because it is wired to PSRAM.
constexpr int FRONT_BALLAST_PIN = 12;
constexpr int REAR_BALLAST_PIN = 13;
constexpr int LEFT_ESC_PIN = 14;
constexpr int RIGHT_ESC_PIN = 15;
constexpr int LIGHT_PIN = 4;

constexpr int FRONT_SERVO_CHANNEL = 2;
constexpr int REAR_SERVO_CHANNEL = 3;
constexpr int LEFT_ESC_CHANNEL = 4;
constexpr int RIGHT_ESC_CHANNEL = 5;
constexpr int LIGHT_CHANNEL = 6;

