# Troubleshooting

## ESP32 does not boot

- Remove GPIO0 from GND after flashing.
- Disconnect external signals from GPIO12 and GPIO15, reset, and test again. A connected device may be overriding a boot strap.
- Confirm a stable regulated 5 V supply at the ESP32-CAM during camera startup. Do not use a weak USB-to-TTL 3.3 V output as the board supply.
- Check the serial console at 115200 baud for brownout or camera initialization messages.

## Camera fails or reboots under load

- Confirm this is an AI-Thinker pin mapping and PSRAM is enabled.
- GPIO16 must not be connected to the left ESC.
- Reseat the OV2640 ribbon cable with power disconnected.
- Improve 5 V regulation, bulk capacitance, star grounding, and separation from ESC/motor wiring.
- Reduce resolution to QVGA or JPEG quality number upward (larger numbers use more compression).

## App opens but submarine remains offline

- Stay connected when Android reports “no internet”.
- The complete UI should remain visible because it is bundled in the APK. If the screen is blank, confirm you installed version 1.2.0 or newer.
- Confirm the status badge changes from Offline/Reconnecting to Link online after joining `SUB-RC-<device-id>`.
- Browse to `http://192.168.4.1` only when checking the ESP diagnostic page; the app itself does not load its UI from that address.
- Try one controlling device and disconnect extra clients.
- Reset the ESP32, wait for the serial ready message, and reload.

## Controls are disabled

- “Monitor” means another client owns the pilot lock or you have not claimed control.
- “Calibration required” is an intentional safety lock; complete dry-bench calibration first.
- Propulsion must be explicitly armed after every boot, disconnect, release, or failsafe.
- Ballast is disabled until valid endpoints exist.

## Link fails underwater

This is expected for a submerged 2.4 GHz antenna. Water absorbs the signal. Move the antenna above water, use a surface buoy/relay, or use a suitable tether. Software cannot correct this physical limitation.

## Motors reset the controller

Stop testing. Verify the buck regulator is sized for ESP32 and simultaneous servo stall current, both ESC BEC positive wires are removed, grounds meet at a star point, and motor wiring is separated/suppressed. Review the serial log for brownout resets before proceeding.

## Android APK will not install

- Enable installation from the app/file manager used to open the APK.
- Remove an older build with a different signing key if Android reports a signature mismatch.
- Android 7.0 or newer is required.
- Use `adb install -r releases/SubmarineRC-v1.2.0.apk` for detailed errors.
