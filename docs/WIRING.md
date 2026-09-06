# Wiring and electrical safety

## Signal allocation

| Function | GPIO | Notes |
| --- | ---: | --- |
| Front ballast servo signal | 12 | Boot strap pin; fit the recommended pulldown and verify boot before attaching linkage |
| Rear ballast servo signal | 13 | PWM signal only |
| Left bidirectional ESC signal | 14 | Chosen instead of GPIO16 so PSRAM remains available |
| Right bidirectional ESC signal | 15 | Boot strap pin; fit the recommended pulldown |
| Onboard flash LED | 4 | PWM brightness; microSD cannot be used |

The OV2640 uses GPIO0, 5, 18, 19, 21–23, 25–27, 32, 34–36, and 39 exactly as defined in `esp-materials/include/pins.h`. GPIO16 and GPIO17 are tied to ESP32-CAM PSRAM and must remain unavailable.

## Power architecture

Do not power the motors or moving servos through the ESP32-CAM board.

```text
3S battery
  |
  +-- correctly rated battery fuse --+-- left ESC power  -> left motor
  |                                   +-- right ESC power -> right motor
  |
  +-- regulated 5 V buck, adequately rated
       +-- ESP32-CAM 5V pin
       +-- front servo +5V
       +-- rear servo +5V

All grounds join at one low-impedance star point:
battery/ESC grounds + buck ground + ESP32 ground + both servo grounds.
```

- Size the 5 V buck for the ESP32-CAM current peaks plus the **combined stall current of both servos**, with margin. A small phone-style regulator may brown out when both syringes load up.
- Power both propulsion ESCs directly from the fused 3S pack.
- Disconnect and insulate the positive/red BEC lead from **both** ESC receiver connectors. Connect only ESC signal and ground to the controller side. This prevents two BECs and the buck regulator from fighting each other.
- Put at least 470–1000 µF low-ESR bulk capacitance near the ESP32/servo 5 V distribution, plus normal ceramic decoupling. Observe capacitor voltage rating and polarity.
- Select the fuse from measured system current and wire ampacity, not from guesswork. Install it close to the battery.
- Use the listed 14 AWG wire for battery/motor current paths only where appropriate. Use flexible smaller-gauge wire for logic and short servo signal runs.

## Boot-strapping pins

GPIO12 affects the ESP32 flash voltage strap and GPIO15 is also sampled during reset. External hardware that pulls either pin high at boot can prevent startup or, in the worst case, select the wrong flash voltage.

- Fit approximately 10 kΩ pulldowns from GPIO12 and GPIO15 signal lines to GND at the ESP32 side.
- Keep the ESC/servo signal interface high-impedance while the ESP32 resets.
- Test at least 20 cold boots with the real ESCs and servos connected but propellers removed.
- If any attached device holds a strap pin high, add a proper buffer/level stage whose output stays disabled during reset. A pulldown alone is not a cure for a strongly driven signal.

GPIO0 is also a boot strap and camera clock. Use it only for the documented flash-mode link to GND, and remove that link before normal reset.

## Noise and radio

- Keep motor phase and battery wires away from the camera ribbon, antenna, and PWM signal wires.
- Twist each signal wire with its ground return where practical. Add ferrite suppression and ESC/motor filtering based on measured noise.
- Use star grounding and short, low-impedance supply paths. Do not daisy-chain servo current through the ESP32 ground pin.
- Keep the ESP32-CAM PCB antenna clear of carbon fibre, metal, battery cells, and water. Do not place the antenna inside a conductive or fully submerged enclosure.
- 2.4 GHz does not propagate usefully through more than a small amount of water. Use an antenna above the waterline, a surface buoy/relay, or a tether for real submerged control.

## Version 1 unused/optional BOM parts

The N20 geared motors, potentiometers, linear potentiometer, reed switches, IRF4905 MOSFETs, 2N3904 transistors, perfboard light circuit, and related resistors/LEDs are not required by version 1. Ballast uses the two servos and syringes; illumination uses the ESP32-CAM onboard flash LED. Keep unused pins and wires insulated.
