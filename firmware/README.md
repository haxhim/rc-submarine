# ESP32-CAM firmware

## Target

- Board: AI-Thinker ESP32-CAM, 4 MB flash, PSRAM enabled
- Camera: OV2640
- Framework: Arduino through PlatformIO
- Network: local access point at `192.168.4.1`
- UI storage: LittleFS; microSD is disabled and its pins are repurposed

The camera pin map in `include/pins.h` matches the supplied AI-Thinker mapping. GPIO16 is not used for an ESC because it is connected to PSRAM. The left ESC moves to GPIO14.

## Build

Install Python 3 and PlatformIO Core, then run from the project root:

```bash
python3 -m pip install --user platformio
./scripts/build-firmware.sh
```

That command builds the web interface, copies it into `firmware/data`, compiles the application, creates the LittleFS image, and emits individual plus merged binaries in `releases/firmware`.

## Flash a complete release

Use a stable 5 V supply and a USB-to-TTL adapter set to 3.3 V logic levels. Connect adapter GND to ESP32 GND, adapter TX to U0R, and adapter RX to U0T.

1. Disconnect motors and remove propellers.
2. Connect GPIO0 to GND.
3. Press reset or cycle power.
4. Run:

```bash
python3 ~/.platformio/packages/tool-esptoolpy/esptool.py \
  --chip esp32 --port /dev/cu.usbserial-XXXX --baud 460800 \
  write_flash -z 0x0 releases/firmware/SubmarineRC-v1.0.0-merged.bin
```

5. Disconnect GPIO0 from GND.
6. Press reset.
7. Monitor at 115200 baud. The console prints `SUB-RC-xxxxxx ready at http://192.168.4.1`.

If flashing is unreliable, reduce baud to `115200`. On Windows the port looks like `COM5`; on Linux it is commonly `/dev/ttyUSB0`.

## Safe boot behavior

- Both ESC outputs attach at a 1500 µs neutral default and propulsion is disarmed.
- Ballast outputs are not driven if NVS calibration is missing or invalid.
- After valid calibration, boot commands both ballast servos to their calibrated surface/empty endpoints.
- The active pilot must send heartbeats. A timeout defaults to 1000 ms and neutralizes both ESCs, commands both ballast servos to surface, disarms propulsion, and releases the pilot lock.
- Calibration and configuration are range checked before being saved in NVS.

## Endpoints

`GET /`, `/capture`, `/api/status`, and `/stream` are available. `/stream` redirects to the dedicated port 81 stream server so video cannot block control traffic. The WebSocket control endpoint is `/ws`. See `docs/PROTOCOL.md`.

