# ESP Materials and Flashing Guide

This folder contains everything needed for the AI-Thinker ESP32-CAM installed in the submarine.

## Contents

- `src/main.cpp` — submarine control, Wi-Fi, camera, WebSocket, calibration and failsafe code
- `include/pins.h` — exact OV2640, ESC, ballast-servo and light pins
- `include/control_math.h` — direct/legacy motor control, ballast-angle mapping and safe PWM conversion
- `data/` — a tiny LittleFS diagnostic page; the full controller UI lives in the APK
- `platformio.ini` — AI-Thinker ESP32-CAM build configuration
- `partitions.csv` — 4 MB flash layout
- `../releases/esp-materials/SubmarineRC-ESP-v1.3.0.bin` — easiest complete image to flash

Target hardware:

- AI-Thinker ESP32-CAM with 4 MB flash and PSRAM
- OV2640 camera
- Direct local Wi-Fi at `192.168.4.1`
- microSD disabled because its pins are used for the controls

GPIO16 is deliberately not used for an ESC because it is connected to PSRAM. The bench-confirmed mapping is left ESC GPIO15 and right ESC GPIO14.

## Before connecting the programmer

1. Remove both propellers.
2. Disconnect propulsion battery/ESC power and servo power.
3. Use a USB-to-TTL serial adapter with **3.3 V logic levels**.
4. Power the ESP32-CAM through a stable regulated 5 V supply connected to `5V` and `GND`. Many USB-to-TTL adapters cannot supply camera current peaks reliably.
5. Never apply 5 V logic to `U0R`, `U0T`, or any ESP GPIO.

## Programmer wiring

| USB-to-TTL adapter | ESP32-CAM |
| --- | --- |
| GND | GND |
| TX | U0R / GPIO3 |
| RX | U0T / GPIO1 |
| 5 V supply positive | 5V |
| Temporary jumper | GPIO0 to GND |

TX and RX are crossed: adapter TX goes to ESP RX (`U0R`), and adapter RX goes to ESP TX (`U0T`). All grounds must be common.

## Method 1: flash the ready-made ESP image

The simplest option is `releases/esp-materials/SubmarineRC-ESP-v1.3.0.bin`.

### 1. Install the flashing tool

Install Python 3, then run:

```bash
python3 -m pip install esptool
```

### 2. Find the serial port

macOS:

```bash
ls /dev/cu.*
```

Linux:

```bash
ls /dev/ttyUSB* /dev/ttyACM*
```

On Windows, open Device Manager → Ports (COM & LPT) and note a port such as `COM5`.

### 3. Enter ESP download mode

1. Connect GPIO0 to GND.
2. Press reset once, or briefly disconnect and reconnect the 5 V supply.
3. Keep GPIO0 connected to GND while flashing.

### 4. Flash at address 0x0

From the root `SubmarineRC` folder, replace the example port with your actual port.

macOS:

```bash
python3 -m esptool --chip esp32 --port /dev/cu.usbserial-XXXX --baud 460800 \
  write_flash -z 0x0 releases/esp-materials/SubmarineRC-ESP-v1.3.0.bin
```

Windows:

```powershell
py -m esptool --chip esp32 --port COM5 --baud 460800 write_flash -z 0x0 releases/esp-materials/SubmarineRC-ESP-v1.3.0.bin
```

Linux:

```bash
python3 -m esptool --chip esp32 --port /dev/ttyUSB0 --baud 460800 \
  write_flash -z 0x0 releases/esp-materials/SubmarineRC-ESP-v1.3.0.bin
```

Wait for esptool to report successful verification. If connection is unreliable, repeat download mode and reduce `--baud 460800` to `--baud 115200`.

### 5. Return to normal boot

1. Disconnect power.
2. Remove the GPIO0-to-GND jumper.
3. Reconnect the normal 5 V supply.
4. Press reset once.

The serial console uses 115200 baud. A successful boot prints something similar to:

```text
SUB-RC-A1B2C3 ready at http://192.168.4.1
```

Join `SUB-RC-<device-id>` from the Android phone with password `NautilusRC!`. Open the Submarine RC APK; it connects directly to the ESP at `192.168.4.1`.

## Method 2: build the ESP code yourself

Install PlatformIO Core:

```bash
python3 -m pip install --user platformio
```

From the root `SubmarineRC` folder:

```bash
npm install
./scripts/build-esp-materials.sh
```

This bundles the full controller into the Android assets, copies only the lightweight diagnostic page into `esp-materials/data`, compiles the ESP code, creates the LittleFS diagnostics image, and recreates everything in `releases/esp-materials`.

You can also compile and upload directly:

```bash
cd esp-materials
pio run
pio run --target upload --upload-port /dev/cu.usbserial-XXXX
```

## Individual ESP image addresses

Use the complete image at `0x0` whenever possible. Advanced individual-image flashing uses:

| ESP material | Address |
| --- | ---: |
| `bootloader.bin` | `0x1000` |
| `partitions.bin` | `0x8000` |
| `boot_app0.bin` | `0xE000` |
| `esp-code.bin` | `0x10000` |
| `littlefs-diagnostics.bin` | `0x210000` |

```bash
python3 -m esptool --chip esp32 --port /dev/cu.usbserial-XXXX --baud 460800 write_flash -z \
  0x1000 releases/esp-materials/bootloader.bin \
  0x8000 releases/esp-materials/partitions.bin \
  0xE000 releases/esp-materials/boot_app0.bin \
  0x10000 releases/esp-materials/esp-code.bin \
  0x210000 releases/esp-materials/littlefs-diagnostics.bin
```

## First connection and calibration

1. Join the ESP Wi-Fi from the Android device.
2. Open the APK and confirm it reports Link online.
3. Claim pilot control.
4. Open Settings.
5. Keep the propellers removed and complete `docs/CALIBRATION.md`.
6. Change the default Wi-Fi password before field use.

The ESP will not arm propulsion until calibration is valid. A lost pilot heartbeat neutralizes both ESCs and commands both calibrated ballast servos to surface.

On the Pilot page, the left and right ESCs have separate forward/neutral/reverse sliders. The sliders automatically return to neutral when released. Ballast uses degrees: `0°` commands the calibrated dive endpoint and `180°` commands the calibrated surface endpoint. There is no separate pump output in version 1.2.

Version 1.3.0 incorporates the confirmed full demo sketch: left ESC GPIO15, right ESC GPIO14, front ballast GPIO12, rear ballast GPIO13, light GPIO4, ESP32Servo at 50 Hz, a QVGA/quality-12 OV2640 startup profile, and 1460-byte MJPEG chunks on port 81. Streaming runs in a separate ESP32 task so it cannot block motor commands or the heartbeat failsafe. Live actuator commands use `/set`, protected by a random token issued only to the active WebSocket pilot.

## Common flashing problems

- **Failed to connect:** confirm GPIO0 is connected to GND, press reset immediately before esptool, and verify TX/RX are crossed.
- **Wrong boot mode:** remove anything driving GPIO12 or GPIO15 during reset and read `docs/WIRING.md`.
- **Brownout or camera restart:** use a stronger regulated 5 V supply with short wires and bulk capacitance.
- **No serial port:** install the adapter’s CP210x, CH340, or FTDI driver and use a data-capable USB cable.
- **Permission denied on Linux:** add the user to the serial-port group such as `dialout`, then sign out and back in.
- **Diagnostic page missing after individual flashing:** flash `littlefs-diagnostics.bin` at `0x210000`, or use the complete image at `0x0`. The Android controller UI is bundled in the APK and does not depend on this page.
