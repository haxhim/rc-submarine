# Hardware bench-test checklist

Keep both propellers removed until the final propeller-specific checks.

## Electrical and boot

- [ ] Battery fuse is installed close to the pack and appropriately rated.
- [ ] Dedicated regulated 5 V buck is correctly adjusted and sized for both servo stall currents plus ESP32 peaks.
- [ ] Both ESC BEC positive/red receiver wires are disconnected and insulated.
- [ ] Battery, ESC, buck, ESP32, and servo grounds meet at a common star point.
- [ ] Bulk capacitor is correctly rated and polarized.
- [ ] GPIO12 and GPIO15 have boot-safe pulldowns and connected equipment is high-impedance at reset.
- [ ] Twenty cold boots succeed with propulsion outputs connected and propellers removed.
- [ ] Brownout does not occur while both servos move under realistic dry load.

## Software and failsafe

- [ ] Camera stream and still capture work at all offered resolutions.
- [ ] A second browser is monitor-only while the first owns pilot control.
- [ ] Propulsion cannot arm before calibration.
- [ ] Boot, disarm, disconnect, and pilot release all leave ESCs neutral.
- [ ] Heartbeat loss neutralizes both ESCs and commands both ballast servos to surface within the selected timeout.
- [ ] Invalid/out-of-range protocol packets are rejected without moving outputs.
- [ ] Configuration survives a full power cycle.

## Mechanical

- [ ] Front and rear syringe endpoints do not bottom out, bind, or stall the servos.
- [ ] Emergency Surface empties both ballast tanks and disarms propulsion.
- [ ] With propellers finally installed in a protected test fixture, motor direction matches the UI and inversion settings.
- [ ] Measured full-load current is within battery, fuse, connectors, wire, ESC, and motor ratings.

## Before water

- [ ] Watertightness passes a static leak test without powered electronics.
- [ ] Antenna has a viable above-water, buoy, or tether arrangement.
- [ ] Pool-side radio range and failsafe are tested progressively.
- [ ] A physical recovery line/method exists.
- [ ] The first powered water test is restrained and supervised.

Passing software simulation is not field validation. Motor direction, servo travel, current capacity, RF range, watertightness, and underwater behavior must be confirmed on the actual submarine.
