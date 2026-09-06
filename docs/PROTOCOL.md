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
{"v":1,"type":"drive","seq":42,"ts":1770000000000,"surge":0.5,"yaw":-0.2,"limit":0.6}
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
| `drive` | `surge`, `yaw` (-1..1), `limit` (0..1) | pilot + armed |
| `ballast` | `front`, `rear` (0..1), optional `mode` | pilot + calibration |
| `light` | `value` (0..1) | pilot |
| `camera` | `frameSize`, `quality` | pilot; QVGA/VGA/SVGA, quality 8..30 |
| `calibration` | pulse endpoints and inversion booleans | pilot + `benchConfirmed:true` |
| `config` | `failsafeMs`, `apPassword`, `restart` | pilot |
| `config_import` | versioned JSON configuration | pilot |
| `emergency_surface` | — | pilot |

The app sends a heartbeat every 250 ms. The ESP code defaults to a 1000 ms deadline. Failsafe releases the pilot lock, disarms and neutralizes propulsion, and moves calibrated ballast outputs to surface/empty.

## Telemetry meaning

- `rssi` is the ESP32’s measured Wi-Fi station signal where supported; `null` means unavailable.
- `uptimeMs`, `clients`, calibration, arm, pilot, failsafe, ballast, light, and camera state come from the ESP code.
- Latency and acknowledgement loss are computed on the client.
- Physical sonar, depth, heading, temperature, leak, battery-current, and similar values do not exist without added sensors.
