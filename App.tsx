import { io } from "socket.io-client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { router, useLocalSearchParams } from "expo-router";
import {
  Reading,
  Settings,
  defaults,
  request,
  selectReadings,
  toCsv,
  parseTelemetry,
  parseSocketReading,
  parseSocketRelay,
  readingSource,
  validateSettings,
  formatReading,
  restoreReadings,
} from "./src/core";

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const HISTORY = "voltlink.history.v1",
  CONFIG = "voltlink.config.v1";
export default function App() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const tab = ["Overview", "History", "Reports", "Device"].includes(
    params.tab ?? "",
  )
    ? params.tab!
    : "Overview";
  const setTab = (value: string) => router.setParams({ tab: value });
  const [settings, setSettings] = useState<Settings>(defaults),
    [draft, setDraft] = useState<Settings>(defaults);
  const [rows, setRows] = useState<Reading[]>([]),
    [live, setLive] = useState<Reading>();
  const [ready, setReady] = useState(false),
    [record, setRecord] = useState(true),
    [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Starting"),
    [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [from, setFrom] = useState(today()),
    [to, setTo] = useState(today());
  const demo = useRef({ relay: true, energy: 0, time: Date.now(), power: 330 });
  const lock = useRef(false),
    generation = useRef(0),
    storage = useRef(Promise.resolve());
  const rowsRef = useRef<Reading[]>([]);
  const telemetryRevision = useRef(0);
  const source = readingSource(settings);
  const recordRef = useRef(record);
  recordRef.current = record;
  useEffect(() => {
    void (async () => {
      try {
        const [history, config] = await Promise.all([
          AsyncStorage.getItem(HISTORY),
          AsyncStorage.getItem(CONFIG),
        ]);
        if (history) {
          const parsed = restoreReadings(JSON.parse(history));
          rowsRef.current = parsed;
          setRows(parsed);
        }
        if (config) {
          const saved = JSON.parse(config);
          const s = validateSettings({
            ...defaults,
            ...saved,
            apiUrl: saved.apiUrl || defaults.apiUrl,
            readingsEvent:
              saved.readingsEvent === "readings"
                ? defaults.readingsEvent
                : (saved.readingsEvent ?? defaults.readingsEvent),
          });
          setSettings(s);
          setDraft(s);
        }
        setReady(true);
      } catch {
        setError(
          "Could not load saved data. Reload before recording to protect existing history.",
        );
      }
    })();
  }, []);
  const persist = useCallback((next: Reading[]) => {
    storage.current = storage.current
      .then(async () => {
        await AsyncStorage.setItem(HISTORY, JSON.stringify(next));
        setStorageError("");
      })
      .catch(() =>
        setStorageError(
          "History could not be saved. Export your readings and check device storage.",
        ),
      );
  }, []);
  const accept = useCallback(
    (values: ReturnType<typeof parseSocketReading>) => {
      const row: Reading = {
        ...values,
        id: Date.now() + "-" + Math.random(),
        timestamp: new Date().toISOString(),
        source,
      };
      setLive(row);
      setStatus(
        settings.demo
          ? "Demo connected"
          : settings.mode === "online"
            ? "API connected"
            : "ESP8266 connected",
      );
      setError("");
      if (recordRef.current) {
        const next = [row, ...rowsRef.current].slice(0, 5000);
        rowsRef.current = next;
        setRows(next);
        persist(next);
      }
    },
    [source, settings.demo, settings.mode, persist],
  );
  const sample = useCallback(
    async (on?: boolean) => {
      if (
        lock.current ||
        !ready ||
        (Platform.OS !== "web" && AppState.currentState !== "active")
      )
        return;
      lock.current = true;
      const version = generation.current,
        revision = telemetryRevision.current;
      setBusy(true);
      try {
        let values;
        if (settings.demo) {
          const now = Date.now();
          demo.current.energy +=
            (demo.current.power * (now - demo.current.time)) / 3600000000;
          demo.current.time = now;
          if (on !== undefined) demo.current.relay = on;
          demo.current.power = demo.current.relay
            ? 320 + Math.random() * 35
            : 0;
          const voltage = 229 + Math.random() * 3;
          values = {
            voltage,
            current: demo.current.power / voltage,
            power: demo.current.power,
            energy: demo.current.energy,
            relay: demo.current.relay,
          };
        } else values = await request(settings, on);
        if (version !== generation.current) return;
        if (on === undefined && revision !== telemetryRevision.current) return;
        if (!values) return;
        if (!("voltage" in values)) {
          if (revision === telemetryRevision.current)
            setLive((previous) =>
              previous ? { ...previous, relay: values.relay } : previous,
            );
          setError("");
          return;
        }
        accept(parseTelemetry(values));
      } catch (e) {
        if (version === generation.current) {
          setStatus("Disconnected");
          setError((e as Error).message || "Connection failed");
        }
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [ready, settings, accept],
  );
  useEffect(() => {
    if (!ready) return;
    generation.current++;
    setLive(undefined);
    setStatus("Connecting");
    const online = !settings.demo && settings.mode === "online";
    const socket = online
      ? io(settings.apiUrl, {
          autoConnect: false,
          path: settings.socketPath,
          auth: { token: settings.apiToken },
          timeout: 20000,
          transports: ["websocket"],
        })
      : undefined;
    let lastRelay: boolean | undefined;
    socket?.on(settings.readingsEvent, (payload: unknown) => {
      if (Platform.OS !== "web" && AppState.currentState !== "active") return;
      try {
        const values = parseSocketReading(payload,lastRelay);
        lastRelay=values.relay;
        telemetryRevision.current++;
        accept(values);
      } catch (e) {
        setError((e as Error).message);
      }
    });
    socket?.on("relay:update", (payload: unknown) => {
      if (Platform.OS !== "web" && AppState.currentState !== "active") return;
      try {
        lastRelay=parseSocketRelay(payload);
        telemetryRevision.current++;
        setLive(previous=>previous?{...previous,relay:lastRelay}:previous);
      } catch(e) { setError((e as Error).message); }
    });
    socket?.on("connect", () => {
      setStatus("API connected; waiting for readings");
      setError("");
    });
    socket?.on("connect_error", (e: Error) => {
      setStatus("Disconnected");
      setError("Socket.IO: " + e.message);
    });
    socket?.on("disconnect", () => {
      setStatus("Disconnected");
      setError("API stream disconnected. Displayed readings may be stale.");
    });
    const start = () => {
      if (socket) socket.connect();
      else void sample();
    };
    if (Platform.OS === "web" || AppState.currentState === "active") start();
    const timer = online
      ? undefined
      : setInterval(() => void sample(), settings.interval * 1000);
    const listener = AppState.addEventListener("change", (state) => {
      generation.current++;
      if (state === "active") start();
      else {
        socket?.disconnect();
        setStatus("Paused");
      }
    });
    return () => {
      clearInterval(timer);
      listener.remove();
      socket?.removeAllListeners();
      socket?.disconnect();
      generation.current++;
    };
  }, [settings, ready, sample, accept]);
  const current = live || rows.find((r) => r.source === source);
  let selected: Reading[] = [],
    dateError = "";
  try {
    selected = selectReadings(rows, source, from, to);
  } catch (e) {
    dateError = (e as Error).message;
  }
  const chronological = [...selected].reverse();
  const consumption = chronological.reduce(
    (total, r, i) =>
      i ? total + Math.max(0, r.energy - chronological[i - 1].energy) : 0,
    0,
  );
  const mean = selected.length
    ? selected.reduce((s, r) => s + r.power, 0) / selected.length
    : 0;
  async function save() {
    try {
      const s = validateSettings(draft);
      if (!Number.isFinite(s.interval) || s.interval < 2 || s.interval > 3600)
        throw new Error("Choose an interval between 2 and 3600 seconds");
      await AsyncStorage.setItem(CONFIG, JSON.stringify(s));
      setSettings(s);
      setDraft(s);
      setTab("Overview");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function exportCsv() {
    try {
      if (dateError) throw new Error(dateError);
      if (!selected.length) throw new Error("No readings in this date range");
      const csv = toCsv(chronological),
        name = `pluggie-${from}-${to}.csv`;
      if (Platform.OS === "web") {
        const url = URL.createObjectURL(
          new Blob([csv], { type: "text/csv;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        if (!(await Sharing.isAvailableAsync()))
          throw new Error("File sharing is unavailable");
        const file = new File(Paths.cache, name);
        file.create({ overwrite: true });
        await file.write(csv);
        await Sharing.shareAsync(file.uri, {
          mimeType: "text/csv",
          UTI: "public.comma-separated-values-text",
        });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      onPress={action}
      disabled={disabled}
      style={[s.button, disabled && { opacity: 0.4 }]}
    >
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
  const metric = (label: string, value: string) => (
    <View key={label} style={s.metric}>
      <Text style={s.muted}>{label}</Text>
      <Text style={s.value}>{value}</Text>
    </View>
  );
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.safe}>
        <StatusBar style="light" />
        <ScrollView contentContainerStyle={s.container}>
          <View style={s.row}>
            <View>
              <Text style={s.brand}>◈ Pluggie</Text>
              <Text style={s.eyebrow}>YOUR ENERGY, IN VIEW</Text>
            </View>
            <View style={s.badge}>
              <Text style={s.accent}>
                {settings.demo
                  ? "DEMO MODE"
                  : settings.mode === "online"
                    ? "ONLINE / API"
                    : "OFFLINE / ESP8266"}
              </Text>
            </View>
          </View>
          <View style={s.nav}>
            {["Overview", "History", "Reports", "Device"].map((t) => (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: t === tab }}
                key={t}
                onPress={() => setTab(t)}
                style={[s.navItem, t === tab && s.active]}
              >
                <Text
                  style={{
                    color: t === tab ? "#092725" : "#aac3c4",
                    fontWeight: "600",
                  }}
                >
                  {t}
                </Text>
              </Pressable>
            ))}
          </View>
          {!!error && (
            <Text accessibilityRole="alert" style={s.error}>
              {error}
            </Text>
          )}
          {!!storageError && (
            <Text accessibilityRole="alert" style={s.error}>
              {storageError}
            </Text>
          )}
          {tab === "Overview" && (
            <>
              <Text style={s.eyebrow}>ENERGY MONITOR</Text>
              <Text style={s.title}>A little more control.</Text>
              <Text style={s.subtitle}>
                Live insights into what powers your space.
              </Text>
              <View style={s.card}>
                <View style={s.row}>
                  <Text style={s.accent}>● {status}</Text>
                  <Text style={s.muted}>
                    {settings.mode === "online" && !settings.demo
                      ? "Live Socket.IO"
                      : `${settings.interval}s updates`}
                  </Text>
                </View>
                <Text style={s.muted}>
                  {settings.demo
                    ? "Simulated readings · no hardware required"
                    : source}
                </Text>
                <Text style={s.power}>
                  {formatReading(current?.power, 1)}{" "}
                  <Text style={s.unit}>W</Text>
                </Text>
                <Text style={s.subtitle}>Active power · watts</Text>
                <View style={s.bars}>
                  {Array.from({ length: 28 }, (_, i) => {
                    const r = rows.filter((r) => r.source === source)[27 - i];
                    return (
                      <View
                        key={i}
                        style={[
                          s.bar,
                          {
                            height: r
                              ? Math.max(3, Math.min(55, r.power / 8))
                              : 3,
                          },
                        ]}
                      />
                    );
                  })}
                </View>
                <Text style={s.muted}>Recent recorded samples</Text>
              </View>
              <View style={s.grid}>
                {metric("Voltage", `${formatReading(current?.voltage, 1)} V`)}
                {metric("Current", `${formatReading(current?.current, 3)} A`)}
                {metric(
                  "Cumulative energy",
                  `${formatReading(current?.energy, 5)} kWh`,
                )}
                {metric(
                  "Frequency",
                  `${formatReading(current?.frequency, 1)} Hz`,
                )}
                {metric("Power factor", formatReading(current?.powerFactor, 2))}
                {metric(
                  "Recorded samples",
                  String(rows.filter((r) => r.source === source).length),
                )}
              </View>
              <View style={s.card}>
                <View style={s.row}>
                  <View>
                    <Text style={s.cardTitle}>Relay control</Text>
                    <Text style={s.subtitle}>
                      Last reported output:{" "}
                      {current?.relay === undefined ? "unknown" : current.relay ? "ON" : "OFF"}
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel="Relay power"
                    value={current?.relay ?? false}
                    disabled={busy || !live || status === "Disconnected"}
                    onValueChange={(v) => void sample(v)}
                    trackColor={{ false: "#375050", true: "#73e6bd" }}
                  />
                </View>
                <Text style={s.muted}>
                  {busy
                    ? "Waiting for device…"
                    : "State updates after device confirmation."}
                </Text>
                {status === "Disconnected" &&
                  button(
                    "Send OFF command",
                    () => void sample(false),
                    busy || !ready,
                  )}
              </View>
              <View style={s.card}>
                <View style={s.row}>
                  <View>
                    <Text style={s.cardTitle}>Record readings</Text>
                    <Text style={s.subtitle}>
                      Timestamped and stored on this device
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel="Record readings"
                    value={record}
                    onValueChange={setRecord}
                  />
                </View>
                <Text style={s.muted}>
                  Recording runs while the app is active. Latest 5,000 samples
                  are retained; export regularly.
                </Text>
              </View>
              {current && (
                <Text style={s.muted}>
                  Last reading: {new Date(current.timestamp).toLocaleString()}
                </Text>
              )}
            </>
          )}
          {(tab === "History" || tab === "Reports") && (
            <>
              <Text style={s.eyebrow}>YOUR ENERGY JOURNAL</Text>
              <Text style={s.title}>
                {tab === "History"
                  ? "Look back. Learn more."
                  : "Readings into reports."}
              </Text>
              <Text style={s.subtitle}>
                Source: {source} · dates use local time
              </Text>
              <View style={s.card}>
                <Text style={s.cardTitle}>Date range</Text>
                <Text style={s.muted}>From / To · YYYY-MM-DD</Text>
                <View style={s.row}>
                  <TextInput
                    accessibilityLabel="Start date"
                    style={[s.input, { flex: 1 }]}
                    value={from}
                    onChangeText={setFrom}
                  />
                  <TextInput
                    accessibilityLabel="End date"
                    style={[s.input, { flex: 1 }]}
                    value={to}
                    onChangeText={setTo}
                  />
                </View>
                {!!dateError && <Text style={s.error}>{dateError}</Text>}
              </View>
              <View style={s.grid}>
                {metric("Samples", String(selected.length))}
                {metric("Mean power", `${mean.toFixed(1)} W`)}
                {metric("Observed energy", `${consumption.toFixed(5)} kWh`)}
                {metric(
                  "Peak power",
                  `${Math.max(0, ...selected.map((r) => r.power)).toFixed(1)} W`,
                )}
              </View>
              {tab === "Reports" ? (
                <View style={s.card}>
                  <Text style={s.cardTitle}>Export your energy report</Text>
                  <Text style={s.subtitle}>
                    CSV includes UTC timestamps, device, voltage, current,
                    watts, cumulative energy, and relay state. Open in Excel or
                    Google Sheets.
                  </Text>
                  {button(
                    "↓ Export CSV",
                    () => void exportCsv(),
                    !selected.length || !!dateError,
                  )}
                  <Text style={s.muted}>
                    Observed energy sums positive meter increments. Gaps and
                    meter resets can underestimate consumption. Mean power is a
                    sample average.
                  </Text>
                </View>
              ) : (
                <View style={s.card}>
                  <Text style={s.cardTitle}>Reading timeline</Text>
                  {!selected.length && (
                    <Text style={s.subtitle}>
                      No readings. Enable recording or change the date range.
                    </Text>
                  )}
                  {selected.slice(0, 100).map((r) => (
                    <View key={r.id} style={s.history}>
                      <View style={s.row}>
                        <Text style={s.cardTitle}>
                          {formatReading(r.power, 1)} W
                        </Text>
                        <Text style={s.accent}>{r.relay === undefined ? "unknown" : r.relay ? "ON" : "OFF"}</Text>
                      </View>
                      <Text style={s.subtitle}>
                        {formatReading(r.voltage, 1)} V ·{" "}
                        {formatReading(r.current, 3)} A ·{" "}
                        {formatReading(r.energy, 5)} kWh
                      </Text>
                      <Text style={s.muted}>
                        {new Date(r.timestamp).toLocaleString()}
                      </Text>
                    </View>
                  ))}
                  {selected.length > 100 && (
                    <Text style={s.muted}>
                      Showing latest 100. Export for full history.
                    </Text>
                  )}
                </View>
              )}
            </>
          )}
          {tab === "Device" && (
            <>
              <Text style={s.eyebrow}>CONNECTION SETTINGS</Text>
              <Text style={s.title}>Meet your device.</Text>
              <Text style={s.subtitle}>
                Online connects through your API. Offline connects directly to
                your ESP8266 on local Wi-Fi without internet.
              </Text>
              <View style={s.card}>
                <View style={s.row}>
                  <Text style={s.cardTitle}>Demo mode</Text>
                  <Switch
                    accessibilityLabel="Demo mode"
                    value={draft.demo}
                    onValueChange={(demo) => setDraft({ ...draft, demo })}
                  />
                </View>
                <Text style={s.muted}>
                  Explore with simulated electrical readings.
                </Text>
                <Text style={s.label}>Connection mode</Text>
                <View style={s.row}>
                  {button(
                    draft.mode === "online" ? "Online (selected)" : "Online",
                    () => setDraft({ ...draft, mode: "online" }),
                  )}
                  {button(
                    draft.mode === "offline" ? "Offline (selected)" : "Offline",
                    () => setDraft({ ...draft, mode: "offline" }),
                  )}
                </View>
                <Text style={s.muted}>
                  Commands use the selected connection. Online readings arrive
                  only through Socket.IO.
                </Text>
                {draft.mode === "online" && (
                  <>
                    {(
                      [
                        ["apiUrl", "API address"],
                        ["apiToken", "API access token"],
                        ["relayPath", "Relay endpoint"],
                        ["socketPath", "Socket.IO path"],
                        ["readingsEvent", "Readings event"],
                      ] as const
                    ).map(([key, label]) => (
                      <View key={key}>
                        <Text style={s.label}>{label}</Text>
                        <TextInput
                          accessibilityLabel={label}
                          secureTextEntry={key === "apiToken"}
                          style={s.input}
                          value={draft[key]}
                          autoCapitalize="none"
                          autoCorrect={false}
                          onChangeText={(value) =>
                            setDraft({ ...draft, [key]: value })
                          }
                        />
                      </View>
                    ))}
                  </>
                )}
                <Text style={s.label}>ESP8266 address</Text>
                <TextInput
                  accessibilityLabel="ESP8266 address"
                  style={s.input}
                  value={draft.url}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(url) => setDraft({ ...draft, url })}
                />
                <Text style={s.label}>Device access token</Text>
                <TextInput
                  accessibilityLabel="Device access token"
                  secureTextEntry
                  style={s.input}
                  value={draft.token}
                  autoCapitalize="none"
                  onChangeText={(token) => setDraft({ ...draft, token })}
                />
                <Text style={s.label}>
                  Offline / demo sampling interval (seconds)
                </Text>
                <TextInput
                  accessibilityLabel="Sampling interval"
                  keyboardType="numeric"
                  style={s.input}
                  value={String(draft.interval)}
                  onChangeText={(v) =>
                    setDraft({ ...draft, interval: Number(v) })
                  }
                />
                {button("Save & connect", () => void save(), !ready)}
                <Text style={s.muted}>
                  Settings and token are stored locally. Use a trusted network.
                  Firmware and device setup are included in the project README.
                </Text>
              </View>
            </>
          )}
          <Text style={s.footer}>PLUGGIE · ESP8266 ENERGY CONTROLLER</Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#091b1e" },
  container: {
    padding: 22,
    paddingBottom: 40,
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
    gap: 18,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  brand: { fontSize: 27, fontWeight: "800", color: "#edf8f4", marginBottom: 8 },
  eyebrow: { color: "#73e6bd", fontSize: 10, letterSpacing: 2, marginTop: 10 },
  badge: { padding: 10, backgroundColor: "#173b35", borderRadius: 20 },
  accent: { color: "#73e6bd", fontSize: 12, fontWeight: "600" },
  nav: {
    flexDirection: "row",
    padding: 5,
    backgroundColor: "#142d30",
    borderRadius: 16,
  },
  navItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 12,
  },
  active: { backgroundColor: "#73e6bd" },
  title: {
    color: "#edf8f4",
    fontSize: 32,
    fontWeight: "700",
    letterSpacing: -1,
  },
  subtitle: { color: "#aac3c4", fontSize: 14, lineHeight: 22 },
  muted: { color: "#8aa6a8", fontSize: 12, lineHeight: 19 },
  card: {
    backgroundColor: "#142d30",
    borderWidth: 1,
    borderColor: "#244145",
    padding: 22,
    borderRadius: 22,
    gap: 12,
  },
  cardTitle: { color: "#edf8f4", fontSize: 16, fontWeight: "600" },
  power: {
    color: "#edf8f4",
    fontSize: 64,
    fontWeight: "700",
    letterSpacing: -2,
  },
  unit: { fontSize: 26, color: "#73e6bd" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  metric: {
    width: "47%",
    flexGrow: 1,
    padding: 18,
    backgroundColor: "#142d30",
    borderRadius: 18,
    gap: 10,
  },
  value: { fontSize: 22, fontWeight: "600", color: "#edf8f4" },
  bars: { height: 60, flexDirection: "row", alignItems: "flex-end", gap: 4 },
  bar: { flex: 1, backgroundColor: "#73e6bd", borderRadius: 3 },
  input: {
    color: "#edf8f4",
    backgroundColor: "#0b2225",
    borderWidth: 1,
    borderColor: "#345154",
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
  },
  label: { color: "#bfd2d2", fontSize: 13, marginTop: 8 },
  button: {
    backgroundColor: "#73e6bd",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    marginVertical: 8,
  },
  buttonText: { color: "#092725", fontWeight: "700", fontSize: 15 },
  error: {
    color: "#ffb6a5",
    backgroundColor: "#3a2828",
    padding: 14,
    borderRadius: 12,
    lineHeight: 21,
  },
  history: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#2a4548",
    gap: 5,
  },
  footer: {
    color: "#597879",
    fontSize: 10,
    letterSpacing: 2,
    textAlign: "center",
    marginTop: 20,
  },
});
