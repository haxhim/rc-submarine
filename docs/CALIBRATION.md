# Dry-bench calibration

Calibration is intentionally required before propulsion can arm. Perform it in a dry, ventilated workspace with the submarine secured.

## Before starting

1. Remove both propellers from the motor shafts.
2. Disconnect syringe linkages if the servos could over-travel or bind.
3. Verify the fused power distribution, 5 V regulator output, common ground, and removed ESC BEC positive leads.
4. Power the transmitter/controller first, then the ESC power system according to the ESC manufacturer’s instructions.
5. Join the ESP32 Wi-Fi, open Settings, claim pilot control, and tick the propellers-removed confirmation.

## ESC values

Start with minimum 1100 µs, neutral 1500 µs, and maximum 1900 µs. These are conservative generic values, not guaranteed values for your ESC model. Consult the ESC manual before changing them.

Save calibration while propulsion remains disarmed. Arm briefly at a low throttle limit and confirm each motor responds in the expected direction. Use left/right inversion for software correction. If an ESC requires a special endpoint programming sequence, follow its manual with propellers removed; the application does not automatically guess that sequence.

## Ballast endpoints

Use small adjustments. Determine the front surface/empty and dive/full pulse values without letting the syringe bottom out, the linkage bind, or the servo remain stalled. Repeat for the rear tank. Typical hobby-servo pulses fall within 1000–2000 µs, but the software accepts only the broader safety envelope of 800–2200 µs.

After saving, use Surface and Dive while observing current draw and mechanical travel. Stop immediately if a servo chatters, stalls, overheats, or pushes the syringe against its hard stop. Reverse a servo with its inversion checkbox instead of crossing the endpoint meaning.

## Failsafe check

With propellers still removed:

1. Claim control and arm.
2. Apply a small drive command.
3. Close the browser/app or disable phone Wi-Fi.
4. Within the configured timeout (default 1 second), both ESCs must return to neutral and both ballast tanks must command their surface/empty endpoints.
5. Reconnect. The controller must show disarmed/failsafe and require a new pilot claim.

Do not install propellers until every item in `BENCH_TEST.md` passes.

