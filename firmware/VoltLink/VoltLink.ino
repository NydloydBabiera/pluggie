// Arduino ESP32 + ArduinoJson 7 + PZEM004Tv30 libraries.
// Example sensor adapter: PZEM-004T v3. Change readSensor() for your sensor.
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <PZEM004Tv30.h>

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* ACCESS_TOKEN = "CHANGE_TO_A_LONG_RANDOM_TOKEN";
// Set this to the exact Expo web origin when using a browser.
const char* WEB_ORIGIN = "http://localhost:8081";
const int RELAY_PIN = 26;
const bool RELAY_ACTIVE_LOW = true;
PZEM004Tv30 meter(Serial2, 16, 17); // ESP32 RX, TX; check your board's pin availability.
WebServer server(80);
bool relayOn = false;

void cors() {
  server.sendHeader("Access-Control-Allow-Origin", WEB_ORIGIN);
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  server.sendHeader("Vary", "Origin");
  server.sendHeader("Cache-Control", "no-store");
}
bool authorized() {
  if (server.header("Authorization") == String("Bearer ") + ACCESS_TOKEN) return true;
  cors(); server.send(401, "application/json", "{\"error\":\"Unauthorized\"}"); return false;
}
void setRelay(bool on) {
  relayOn = on;
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? (on ? LOW : HIGH) : (on ? HIGH : LOW));
}
bool readSensor(JsonDocument& data) {
  float voltage = meter.voltage(), current = meter.current(), power = meter.power(), energy = meter.energy();
  if (!isfinite(voltage) || !isfinite(current) || !isfinite(power) || !isfinite(energy)) return false;
  data["voltage"] = voltage; data["current"] = current;
  data["power"] = power; data["energy"] = energy; // PZEM energy is kWh.
  return true;
}
void sendReadings() {
  JsonDocument data;
  cors();
  if (!readSensor(data)) { server.send(503, "application/json", "{\"error\":\"Sensor unavailable\"}"); return; }
  data["relay"] = relayOn;
  String json; serializeJson(data, json); server.send(200, "application/json", json);
}
void setup() {
  Serial.begin(115200);
  // Start OFF on reboot. Confirm polarity on a low-voltage test load first.
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
  pinMode(RELAY_PIN, OUTPUT); setRelay(false);
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) delay(200);
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.mode(WIFI_AP); WiFi.softAP("VoltLink-ESP32", "voltlink-setup");
    Serial.print("Access point address: "); Serial.println(WiFi.softAPIP());
  } else { Serial.print("Device address: "); Serial.println(WiFi.localIP()); }
  const char* headers[] = { "Authorization" }; server.collectHeaders(headers, 1);
  server.on("/api/readings", HTTP_GET, []() { if (authorized()) sendReadings(); });
  server.on("/api/relay", HTTP_POST, []() {
    if (!authorized()) return;
    JsonDocument body;
    if (deserializeJson(body, server.arg("plain")) || !body["on"].is<bool>()) {
      cors(); server.send(400,"application/json","{\"error\":\"Expected boolean on\"}"); return;
    }
    const bool requestedOn = body["on"].as<bool>();
    // OFF commands remain possible even if the sensor is unavailable.
    if (!requestedOn) setRelay(false);
    // Require functioning telemetry before switching ON.
    JsonDocument data;
    if (!readSensor(data)) { cors(); server.send(503,"application/json","{\"error\":\"Sensor unavailable\"}"); return; }
    setRelay(requestedOn); data["relay"] = relayOn;
    String json; serializeJson(data,json); cors(); server.send(200,"application/json",json);
  });
  server.on("/api/readings", HTTP_OPTIONS, []() { cors(); server.send(204); });
  server.on("/api/relay", HTTP_OPTIONS, []() { cors(); server.send(204); });
  server.onNotFound([]() { cors(); server.send(404,"application/json","{\"error\":\"Not found\"}"); });
  server.begin();
}
void loop() { server.handleClient(); }
