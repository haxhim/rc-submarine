# Submarine RC

Submarine RC is a local-only controller for an AI-Thinker ESP32-CAM submarine. The Android APK bundles and renders the complete TypeScript controller itself, so the UI opens even when the submarine is offline. The ESP32 creates its own Wi-Fi network and focuses on camera streaming, telemetry, WebSocket commands, and hardware I/O. No cloud hosting or internet connection is required.

## What is included

- `esp-materials/` — ESP32-CAM code, pin definitions, PlatformIO project, and complete flashing guide
- `web/` — responsive Pilot, Camera, Sonar, Logs, and Settings interface bundled into the APK
- `simulator/` — hardware-free local server at `http://localhost:3000`
- `android/` — native Java WebView wrapper (`my.finalyearproject.submarinerc`)
- `releases/` — compiled ESP images and sideload APK after a release build
- `docs/` — wiring, calibration, protocol, troubleshooting, and bench-test instructions

The landscape Pilot screen is arranged like a physical controller: the left ESC slider sits at the far left, the live camera stays in the centre, the right ESC slider sits beside the camera, and ballast/telemetry utilities sit at the far right. Both motor sliders spring back to neutral on release. Ballast uses a 0–180° master angle with independent front/rear trim (`0°` dive, `180°` surface).

## Important safety limitations

This software has not physically tested your motors, servo travel, power system, radio range, hull, or seals. Remove both propellers for every initial power-on and calibration. Fit a battery fuse and a properly sized regulated 5 V buck supply. Never power moving servos from the ESP32-CAM 3.3 V pin.

2.4 GHz Wi-Fi is strongly attenuated by water. A fully submerged ESP32-CAM antenna will normally have extremely short or unusable range. Keep the antenna above the waterline, use a surface buoy/relay, or use a suitable tether for dependable submerged operation. Treat a pool-side browser demonstration and a field-safe underwater link as different engineering milestones.

The current BOM contains no depth, heading, temperature, leak, battery-current, or physical sonar sensors. The interface deliberately reports these as unavailable instead of inventing readings. Its “Sonar” page contains real control-link diagnostics plus an explicit “hardware not installed” state.

## Quick start without hardware

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, click **Claim control**, then use all five sections. The simulator starts with a safe demonstration calibration already present. Stop it with `Ctrl+C`.

```bash
npm test
```

## Hardware start

1. Read [WIRING.md](docs/WIRING.md) completely and wire the power system with the battery disconnected.
2. Open the step-by-step [ESP Materials flashing guide](esp-materials/README.md).
3. Flash the ESP32-CAM with GPIO0 connected to GND, then remove GPIO0 from GND and reset.
4. Join `SUB-RC-<device-id>` using the default password `NautilusRC!`.
5. Install the Android app from `releases/SubmarineRC-v1.2.0.apk`. Its UI opens immediately and connects directly to the ESP at `192.168.4.1` when the submarine Wi-Fi is available.
6. With propellers removed, claim control and complete [CALIBRATION.md](docs/CALIBRATION.md).

Change the default Wi-Fi password before field use. The controller is intentionally limited to two simultaneous Wi-Fi clients and one active pilot.

## Standard builds

```bash
npm run build:web
./scripts/build-esp-materials.sh
npm run build:android
npm run package:apk
```

For Android Studio instructions and signing notes, see [android/README.md](android/README.md). For packet details, see [PROTOCOL.md](docs/PROTOCOL.md).

## Release contents

The ready-to-flash ESP image is written as one file at address `0x0`. Individual ESP materials are also supplied for recovery and inspection:

| File | Flash address |
| --- | ---: |
| `SubmarineRC-ESP-v1.2.0.bin` | `0x0` |
| `bootloader.bin` | `0x1000` |
| `partitions.bin` | `0x8000` |
| `boot_app0.bin` | `0xE000` |
| `esp-code.bin` | `0x10000` |
| `littlefs-diagnostics.bin` | `0x210000` |

See [BENCH_TEST.md](docs/BENCH_TEST.md) before installing propellers or placing the electronics in the hull.
