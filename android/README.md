# Android application

The app is a native Java WebView controller with the complete interface bundled inside the APK. It never needs the ESP32 to render its navigation, controls, logs, settings, or offline state.

- Package: `my.finalyearproject.submarinerc`
- Minimum Android: 7.0 (API 24)
- Bundled UI origin: `https://appassets.androidplatform.net/controller/` (served internally by the app, never over the internet)
- Submarine controller: `http://192.168.4.1`
- Allowed external WebView host: only `192.168.4.1` on ports 80 and 81
- Permissions: internet, network state, and Wi-Fi state only

The app does not request the phone camera, microphone, location, or broad storage access. Captures, WebM recordings, CSV logs, and JSON configuration exports are saved through a narrow JavaScript bridge to `Downloads/SubmarineRC` on modern Android. When the ESP is unavailable, the full controller remains visible with safe disabled outputs, an offline/reconnecting badge, Wi-Fi guidance, and retry action.

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

The result is `releases/SubmarineRC-v1.2.1.apk`. The supplied APK uses the standard debug signing key and is suitable for sideloading/testing only.

Install with:

```bash
adb install -r releases/SubmarineRC-v1.2.1.apk
```

Android may warn that the Wi-Fi network has no internet. Choose to remain connected. The APK intentionally permits cleartext HTTP only for the private controller address.

## Play Store signing

Play Store publication requires a private release keystore owned and backed up by you. Do not publish with the debug key. Replace `signingConfig signingConfigs.debug` in `app/build.gradle` with a release signing configuration supplied through an uncommitted `keystore.properties` file or CI secret.
