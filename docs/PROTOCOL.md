# Local protocol v1

All state stays on the ESP32 or controlling device. There is no cloud service.

## HTTP

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | LittleFS-hosted controller |
| GET | `/api/status` | Current public state JSON |
| GET | `/capture` | One OV2640 JPEG |
| GET | `/stream` | Redirect to MJPEG stream on port 81 |
| WS | `/ws` | Versioned control and acknowledgements |

## WebSocket packet shape

Every client command contains `v`, `type`, `seq`, and `ts`:

```json
{"v":1,"type":"motors","seq":42,"ts":1770000000000,"left":0.5,"right":0.35,"limit":0.6}
```

The controller responds with the same sequence and a state snapshot:

```json
{"v":1,"type":"ack","seq":42,"ok":true,"state":{"calibrated":true,"armed":true,"pilot":true,"failsafe":false}}
```

Validation failures set `ok:false` and include a human-readable `message`. Clients must not treat a sent command as applied until an acknowledgement arrives.

## Commands

| Type | Main fields | Guard |
| --- | --- | --- |
| `hello` | `client`, `protocol` | any client |
| `heartbeat` | — | refreshes timer only for active pilot |
| `claim` / `release` | — | one active pilot |
| `arm` | `armed` boolean | pilot + valid calibration |
| `motors` | `left`, `right` (-1..1), `limit` (0..1) | pilot + armed |
| `ballast_angle` | `frontDeg`, `rearDeg` integer (0..180), optional `mode` | pilot + calibration |
| `drive` | Legacy `surge`, `yaw` (-1..1), `limit` (0..1) | pilot + armed |
| `ballast` | Legacy `front`, `rear` (0..1), optional `mode` | pilot + calibration |
| `light` | `value` (0..1) | pilot |
| `camera` | `frameSize`, `quality` | pilot; QVGA/VGA/SVGA, quality 8..30 |
| `calibration` | pulse endpoints and inversion booleans | pilot + `benchConfirmed:true` |
| `config` | `failsafeMs`, `apPassword`, `restart` | pilot |
| `config_import` | versioned JSON configuration | pilot |
| `emergency_surface` | — | pilot |

The app sends a heartbeat every 250 ms. The ESP code defaults to a 1000 ms deadline. Failsafe releases the pilot lock, disarms and neutralizes propulsion, and moves calibrated ballast outputs to surface/empty.

The v1.1 app sends both motor values together. `-1` is full calibrated reverse, `0` is neutral and `1` is full calibrated forward before applying `limit`. Its two UI sliders return to zero when released. Legacy `drive` remains available so an older controller can still talk to the v1.1 ESP image.

Ballast angles describe the intended position: `0°` is dive, `90°` is midpoint and `180°` is surface. The controller maps those angles through each servo's calibrated dive/surface pulse endpoints. Legacy normalized ballast uses `0` for surface and `1` for dive.

## Telemetry meaning

- `rssi` is the ESP32’s measured Wi-Fi station signal where supported; `null` means unavailable.
- `uptimeMs`, `clients`, calibration, arm, pilot, failsafe, ballast, light, and camera state come from the ESP code.
- `leftMotor` and `rightMotor` report the applied normalized output after limit and inversion.
- `frontBallastDeg` and `rearBallastDeg` report physical UI angles. Legacy `frontBallast` and `rearBallast` remain available for old clients.
- Latency and acknowledgement loss are computed on the client.
- Physical sonar, depth, heading, temperature, leak, battery-current, and similar values do not exist without added sensors.
