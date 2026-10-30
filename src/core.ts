export type Reading = {
  id: string;
  timestamp: string;
  source: string;
  voltage: number;
  current: number;
  power: number;
  energy: number;
  relay?: boolean;
  frequency?: number;
  powerFactor?: number;
};
export type Settings = {
  mode: "online" | "offline";
  apiUrl: string;
  apiToken: string;
  readingsPath: string;
  relayPath: string;
  socketPath: string;
  readingsEvent: string;
  url: string;
  token: string;
  demo: boolean;
  interval: number;
};
export const defaults: Settings = {
  mode: "offline",
  apiUrl: "https://pluggie-api.onrender.com",
  apiToken: "",
  readingsPath: "/api/readings",
  relayPath: "/api/relay",
  socketPath: "/socket.io",
  readingsEvent: "readings:update",
  url: "http://192.168.4.1",
  token: "",
  demo: true,
  interval: 5,
};
export function baseUrl(url: string) {
  const u = new URL(url.trim());
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error("Enter an HTTP or HTTPS address");
  return url.trim().replace(/\/+$/, "");
}
export function parseTelemetry(input: unknown) {
  const envelope = input as Record<string, unknown> | null;
  const v = (envelope?.readings ?? envelope) as Record<string, unknown> | null;
  const state = envelope?.relayState ?? envelope?.state ?? envelope?.relay;
  const relay = state === "on" ? true : state === "off" ? false : state;
  if (!v || typeof relay !== "boolean") throw new Error("Invalid relay state");
  for (const key of ["voltage", "current", "power", "energy"])
    if (
      typeof v[key] !== "number" ||
      !Number.isFinite(v[key]) ||
      (v[key] as number) < 0
    )
      throw new Error(`Invalid ${key} reading`);
  return {
    voltage: v.voltage as number,
    current: v.current as number,
    power: v.power as number,
    energy: v.energy as number,
    relay,
    ...optionalMetric(v, "frequency"),
    ...optionalMetric(v, "powerFactor"),
  };
}
export function parseSocketReading(input: unknown, lastRelay?: boolean) {
  const payload = input as Record<string, unknown> | null;
  const state = payload?.relayState ?? payload?.state ?? payload?.relay ?? lastRelay;
  const values = parseTelemetry({...payload, relayState: state ?? false});
  return {...values, relay: state === undefined ? undefined : values.relay};
}
export function parseSocketRelay(input: unknown): boolean {
  const payload = input as Record<string, unknown> | null;
  if (payload?.state !== 'on' && payload?.state !== 'off') throw new Error('Invalid relay update');
  return payload.state === 'on';
}
function optionalMetric(
  v: Record<string, unknown>,
  key: "frequency" | "powerFactor",
) {
  const value = v[key];
  if (value === undefined) return {};
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (key === "powerFactor" && value > 1)
  )
    throw new Error(`Invalid ${key} reading`);
  return { [key]: value };
}
export function parseRelayResponse(input: unknown): boolean {
  const value = input as Record<string, unknown> | null;
  if (!value || value.ok !== true)
    throw new Error("Relay request was not successful");
  if (value.state !== "on" && value.state !== "off")
    throw new Error("Invalid relay state");
  return value.state === "on";
}
export function formatReading(value: unknown, digits: number): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "—";
}
export function restoreReadings(input: unknown): Reading[] {
  if (!Array.isArray(input)) throw new Error("Invalid saved history");
  return input.flatMap((row: unknown) => {
    if (!row || typeof row !== "object") return [];
    const value = row as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      typeof value.source !== "string" ||
      typeof value.timestamp !== "string" ||
      !Number.isFinite(Date.parse(value.timestamp))
    )
      return [];
    try {
      return [
        {
          ...parseSocketReading(value),
          id: value.id,
          source: value.source,
          timestamp: value.timestamp,
        },
      ];
    } catch {
      return [];
    }
  });
}
export async function request(s: Settings, on?: boolean) {
  const online = s.mode === "online";
  if (online && on === undefined) return;
  const token = online ? s.apiToken : s.token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), online ? 20000 : 5000);
  try {
    const send = async (path: string, command?: boolean) => {
      const response = await fetch(
        `${baseUrl(online ? s.apiUrl : s.url)}${endpointPath(path)}`,
        {
          signal: controller.signal,
          method: command === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(command === undefined
            ? {}
            : { body: JSON.stringify({ state: command ? "on" : "off" }) }),
        },
      );
      if (!response.ok)
        throw new Error(
          `${online ? "API" : "Device"} returned HTTP ${response.status}`,
        );
      return response;
    };
    let confirmedRelay: boolean | undefined;
    if (on !== undefined)
      confirmedRelay = parseRelayResponse(
        await (await send(online ? s.relayPath : "/relay", on)).json(),
      );
    if (online) return { relay: confirmedRelay! };
    const payload = await (
      await send(online ? s.readingsPath : "/readings")
    ).json();
    const status = await (await send("/status")).json();
    if (status?.ok === false)
      throw new Error("Device status request was not successful");
    return parseTelemetry({
      ...status,
      readings: payload?.readings ?? payload,
    });
  } finally {
    clearTimeout(timeout);
  }
}
export function endpointPath(path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /[?#]/.test(path))
    throw new Error(
      "Endpoint paths must start with / and contain no query or fragment",
    );
  return path;
}
export function readingSource(s: Settings) {
  return s.demo ? "Demo" : s.mode === "online" ? `Online: ${s.apiUrl}` : s.url;
}
export function validateSettings(s: Settings): Settings {
  if (!["online", "offline"].includes(s.mode))
    throw new Error("Choose online or offline mode");
  const next = {
    ...s,
    url: baseUrl(s.url),
    apiUrl: s.apiUrl.trim() ? baseUrl(s.apiUrl) : "",
  };
  if (!s.demo && s.mode === "online" && !next.apiUrl)
    throw new Error("Enter your API address");
  for (const path of [s.readingsPath, s.relayPath, s.socketPath])
    endpointPath(path);
  if (
    !s.readingsEvent.trim() ||
    ["connect", "disconnect", "connect_error"].includes(s.readingsEvent)
  )
    throw new Error("Enter a valid readings event");
  if (!Number.isFinite(s.interval) || s.interval < 2 || s.interval > 3600)
    throw new Error("Choose an interval between 2 and 3600 seconds");
  return next;
}
export function selectReadings(
  rows: Reading[],
  source: string,
  from: string,
  to: string,
) {
  const start = Date.parse(`${from}T00:00:00`),
    end = Date.parse(`${to}T23:59:59.999`);
  const valid = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const [y, m, d] = date.split("-").map(Number);
    const value = new Date(`${date}T00:00:00`);
    return (
      value.getFullYear() === y &&
      value.getMonth() === m - 1 &&
      value.getDate() === d
    );
  };
  if (
    !valid(from) ||
    !valid(to) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end
  )
    throw new Error("Enter a valid YYYY-MM-DD date range");
  return rows.filter(
    (r) =>
      r.source === source &&
      Date.parse(r.timestamp) >= start &&
      Date.parse(r.timestamp) <= end,
  );
}
export function toCsv(rows: Reading[]) {
  const quote = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
  return [
    "timestamp_utc,device,voltage_V,current_A,power_W,energy_kWh,relay",
    ...rows.map((r) =>
      [
        r.timestamp,
        r.source,
        r.voltage,
        r.current,
        r.power,
        r.energy,
        r.relay === undefined ? 'UNKNOWN' : r.relay ? "ON" : "OFF",
      ]
        .map(quote)
        .join(","),
    ),
  ].join("\r\n");
}
