# Android application

The app is a native Java WebView shell around the interface served by the ESP32-CAM.

- Package: `my.finalyearproject.submarinerc`
- Minimum Android: 7.0 (API 24)
- Controller: `http://192.168.4.1`
- Allowed WebView hosts: only `192.168.4.1` on ports 80 and 81
- Permissions: internet, network state, and Wi-Fi state only

The app does not request the phone camera, microphone, location, or broad storage access. Captures, WebM recordings, CSV logs, and JSON configuration exports are saved through a narrow JavaScript bridge to `Downloads/SubmarineRC` on modern Android. It displays Wi-Fi connection instructions and a retry action when the controller is offline.

## Build the sideload APK

Set the Android SDK path in `android/local.properties` if Android Studio has not already done so:

```properties
sdk.dir=/Users/your-name/Library/Android/sdk
```

Then run:

```bash
npm run build:android
npm run package:apk
```

The result is `releases/SubmarineRC-v1.0.0.apk`. The supplied APK uses the standard debug signing key and is suitable for sideloading/testing only.

Install with:

```bash
adb install -r releases/SubmarineRC-v1.0.0.apk
```

Android may warn that the Wi-Fi network has no internet. Choose to remain connected. The APK intentionally permits cleartext HTTP only for the private controller address.

## Play Store signing

Play Store publication requires a private release keystore owned and backed up by you. Do not publish with the debug key. Replace `signingConfig signingConfigs.debug` in `app/build.gradle` with a release signing configuration supplied through an uncommitted `keystore.properties` file or CI secret.

