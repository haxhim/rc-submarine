# Dry-bench calibration

Calibration is intentionally required before propulsion can arm. Perform it in a dry, ventilated workspace with the submarine secured.

## Before starting

1. Remove both propellers from the motor shafts.
2. Disconnect syringe linkages if the servos could over-travel or bind.
3. Verify the fused power distribution, 5 V regulator output, common ground, and removed ESC BEC positive leads.
4. Power the transmitter/controller first, then the ESC power system according to the ESC manufacturer’s instructions.
5. Join the ESP32 Wi-Fi, open Settings, claim pilot control, and tick the propellers-removed confirmation.

## ESC values

The supplied bench-tested profile starts at minimum 1000 µs, neutral 1500 µs, and maximum 2000 µs, matching the working reference sketch. These values are not guaranteed for every ESC model; confirm them with the propellers removed.

Save calibration while propulsion remains disarmed. Arm briefly at a low throttle limit and confirm each motor responds in the expected direction. Use left/right inversion for software correction. If an ESC requires a special endpoint programming sequence, follow its manual with propellers removed; the application does not automatically guess that sequence.

The Pilot page provides separate left and right sliders. Both are neutral at the centre, forward above centre and reverse below centre. Each slider automatically returns to neutral when released. Equal values move straight; reducing the left output turns left and reducing the right output turns right.

## Ballast endpoints

The reference sketch attaches both ballast servos at 500–2500 µs. The supplied profile therefore maps `0° Dive` to 500 µs and `180° Surface` to 2500 µs. Use small adjustments and stop before a syringe bottoms out, linkage binds, or servo stalls. The app accepts 500–2500 µs for servo endpoints.

After saving, use the angle controls while observing current draw and mechanical travel. `0°` is the calibrated dive position, `90°` is midpoint and `180°` is the calibrated surface position. The master slider moves both servos; front/rear trims add up to ±30° and clamp safely within 0–180°. Stop immediately if a servo chatters, stalls, overheats, or pushes the syringe against its hard stop. Reverse a servo with its inversion checkbox instead of crossing the endpoint meaning.

## Failsafe check

With propellers still removed:

1. Claim control and arm.
2. Apply a small drive command.
3. Close the browser/app or disable phone Wi-Fi.
4. Within the configured timeout (default 1 second), both ESCs must return to neutral and both ballast servos must command `180°` surface.
5. Reconnect. The controller must show disarmed/failsafe and require a new pilot claim.

Do not install propellers until every item in `BENCH_TEST.md` passes.
