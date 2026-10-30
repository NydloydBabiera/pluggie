# Pluggie

React Native + Expo energy monitor for Android, iOS, and web. Includes relay control, voltage (V), current (A), active power (watts), cumulative energy (kWh), local timestamped history, date filtering, report summaries, and CSV export. Watts are the unit of power, so they appear together.

## Run

```sh
npm install
npm start
# Browser
npm run web
# Verify
npm run typecheck
npm run lint
npm test
```

Scan the development QR code using a compatible Expo Go version. For native networking configuration, use a development build (`npx expo run:android` or `npx expo run:ios`, with the relevant native toolchain). iOS compilation requires macOS or an EAS cloud build. No cloud account is required for demo mode or local device communication.

## Android APK and iOS builds

Cloud builds use the profiles in `eas.json`. Sign in to your Expo account first:

```sh
npx eas-cli@latest login
npx eas-cli@latest build --platform android --profile preview
npx eas-cli@latest build --platform ios --profile preview
```

The preview Android build produces an installable APK. The preview iOS build produces an IPA for registered devices and requires a paid Apple Developer account. Register iPhones with `npx eas-cli@latest device:create` before building. EAS prompts to link or create the Expo project and configure signing credentials on the first build. Download completed builds from the URLs printed by EAS.

For Google Play (AAB) or Apple TestFlight/App Store (IPA), use `--profile production` instead. Building does not submit the app to a store.

## Connect the ESP32

1. In Arduino IDE, install the ESP32 board package, ArduinoJson 7, and PZEM004Tv30 library.
2. Open `firmware/VoltLink/VoltLink.ino`. Configure Wi-Fi, a long random access token, relay GPIO/polarity, and sensor UART pins. This is an example adapter for **PZEM-004T v3**, not an assumption about your existing hardware. Replace `readSensor()` if you use another sensor.
3. Flash the firmware and read its IP address from Serial Monitor at 115200 baud. If Wi-Fi fails, join `VoltLink-ESP32` (password `voltlink-setup`), address `http://192.168.4.1`. Change the access-point password before regular use.
4. In the app's Device tab, disable Demo mode, enter the address and matching token, and Save & connect. The phone and board must share a reachable network; guest Wi-Fi client isolation can prevent access.
5. Confirm live readings before switching the relay. Firmware starts the relay OFF after reset and refuses ON commands when the sensor is unavailable. OFF commands remain available using Send OFF command on the disconnected screen. If telemetry still fails, the app cannot confirm the resulting state even when firmware accepted OFF. A relay remains in its last commanded state when the app disconnects.

Mains wiring requires appropriately rated, isolated hardware and qualified installation. Confirm relay polarity and GPIO behavior using a low-voltage load before connecting mains; firmware cannot guarantee electrical safety or verify physical relay contacts.

## HTTP contract

All requests use `Authorization: Bearer <token>`. Both endpoints return:

```json
{"voltage":230.1,"current":1.45,"power":330.0,"energy":0.125,"relay":true}
```

- `GET /api/readings`: return current measured values; energy is the cumulative meter counter in kWh.
- `POST /api/relay`, JSON body `{"on":true}` or `{"on":false}`: change output and return telemetry with confirmed logical relay state.
- `401`: incorrect token; `400`: malformed command; `503`: sensor unavailable. Failed readings are never recorded as zero.

The app adds its own UTC receipt timestamp. Polls do not overlap and timeout after 5 seconds. The app does not record while closed or backgrounded. For continuous unattended logging, extend firmware with persistent timestamped storage or a server and a synchronization endpoint.

## History and reports

Demo readings and each configured device address have separate histories. Latest 5,000 samples are retained across all sources; at a five-second interval this covers roughly 6.9 hours of continuous recording. Export regularly or use a longer sampling interval for longer retention. History displays the latest 100 matches; CSV exports all matches for the selected local date range, in chronological order, with UTC timestamps. Data lives on this installation and does not sync between devices. Clearing browser/app data removes history.

Report mean power is a sample average. Observed energy sums positive cumulative meter increments between recorded samples; resets and gaps can underestimate consumption. It is not a utility billing calculation. A date range with one sample has no observable energy increment.

## Network and platform notes

Native builds permit local HTTP for the ESP32. This is intended for a trusted LAN: HTTP and locally stored access tokens are not encrypted end to end. Do not expose this server directly to the internet.

For web, set firmware `WEB_ORIGIN` to your exact browser origin. Use local HTTP development when talking to an HTTP board. An HTTPS-hosted page generally cannot fetch an HTTP ESP32 because of mixed-content restrictions; deploy an HTTPS gateway for that use case. Browser local-network permissions may also require approval. Native configuration changes take effect in a rebuilt app, not inside Expo Go.

API references: [Expo SDK](https://docs.expo.dev/versions/latest/), [PZEM library](https://github.com/mandulaj/PZEM-004T-v30), [Apple local networking](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking).

## Validation and release limits

Protocol/report tests, TypeScript, lint, SDK dependency alignment, and Android/iOS/web JavaScript bundle export are checked. Native APK/IPA compilation and physical ESP32/sensor testing require your hardware and build environment. Dependency installation currently reports 29 audit findings (11 moderate, 18 high); review and resolve relevant transitive dependency advisories before production release. No forced major dependency upgrades have been applied.

## Online API and offline ESP8266 modes

In Device settings, disable Demo mode, choose Online or Offline, then Save & connect.

Online defaults to https://pluggie-api.onrender.com. It receives readings only through Socket.IO event readings:update (path /socket.io). The live event sends flat measurements (relay state arrives separately):

```json
{"voltage":220.9,"current":0,"power":0,"energy":0.001,"frequency":60.1,"powerFactor":0}
```

Relay commands POST /api/relay with {"state":"on"} or {"state":"off"}. Relay responses use {"ok":true,"state":"off"} (or "on"). The app validates ok and state separately from sensor telemetry, then updates the displayed relay state without fetching or recording sensor readings. Offline polling reads relay state from /status; a relay response is never recorded as a sensor measurement. Socket.IO reconnects automatically and waits for the next readings event. Online mode makes no readings GET requests on connect, reconnect, timers, or relay commands. The sampling interval applies only to Offline and Demo modes. Online requests allow 20 seconds, local requests 5 seconds.

Offline uses the configured ESP8266 address: GET /readings for measurements, GET /status for relay state, and POST /relay for commands. The local command body currently uses the same state format. Local readings may be flat or nested under readings; status accepts relayState/state with on/off strings, or relay with a boolean. Adjust these adapters if the firmware differs. No internet is required; the phone must reach the board over Wi-Fi.

API and board tokens are separate. HTTP uses Bearer tokens and Socket.IO uses auth.token. Online and offline histories are separate. Mode selection is explicit and commands do not automatically fall back to another connection. Frequency and power factor appear when provided. Existing saved empty API addresses and the former readings event migrate to these defaults.

The bundled Arduino sketch and the earlier ESP32 setup/HTTP contract describe the legacy example firmware; they do not implement the current ESP8266 endpoints. Use your ESP8266 firmware for Offline mode. Browser access also requires compatible CORS and network origins. Native networking and recording pause while the app is backgrounded.

Socket.IO also emits `relay:update` with `{"state":"off"}` or `{"state":"on"}`. Readings display immediately without waiting for relay state; an unknown relay displays as unknown until reported. Nested readings payloads remain supported. The client uses WebSocket transport with a 20-second connection timeout.
