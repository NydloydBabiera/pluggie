export type Reading = { id: string; timestamp: string; source: string; voltage: number; current: number; power: number; energy: number; relay: boolean };
export type Settings = { url: string; token: string; demo: boolean; interval: number };
export const defaults: Settings = { url: 'http://192.168.4.1', token: '', demo: true, interval: 5 };
export function baseUrl(url: string) {
  const u = new URL(url.trim());
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Enter an HTTP or HTTPS address');
  return url.trim().replace(/\/+$/, '');
}
export function parseTelemetry(input: unknown) {
  const v = input as Record<string, unknown>;
  if (!v || typeof v.relay !== 'boolean') throw new Error('Invalid relay state');
  for (const key of ['voltage', 'current', 'power', 'energy']) if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || (v[key] as number) < 0) throw new Error(`Invalid ${key} reading`);
  return { voltage: v.voltage as number, current: v.current as number, power: v.power as number, energy: v.energy as number, relay: v.relay };
}
export async function request(s: Settings, on?: boolean) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl(s.url)}/api/${on === undefined ? 'readings' : 'relay'}`, { signal: controller.signal, method: on === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(s.token ? { Authorization: `Bearer ${s.token}` } : {}) }, ...(on === undefined ? {} : { body: JSON.stringify({ on }) }) });
    if (!response.ok) throw new Error(`Device returned HTTP ${response.status}`);
    return parseTelemetry(await response.json());
  } finally { clearTimeout(timeout); }
}
export function selectReadings(rows: Reading[], source: string, from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00`), end = Date.parse(`${to}T23:59:59.999`);
  const valid = (date: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false; const [y,m,d]=date.split('-').map(Number); const value=new Date(`${date}T00:00:00`); return value.getFullYear()===y && value.getMonth()===m-1 && value.getDate()===d; };
  if (!valid(from) || !valid(to) || !Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Enter a valid YYYY-MM-DD date range');
  return rows.filter(r => r.source === source && Date.parse(r.timestamp) >= start && Date.parse(r.timestamp) <= end);
}
export function toCsv(rows: Reading[]) {
  const quote = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
  return ['timestamp_utc,device,voltage_V,current_A,power_W,energy_kWh,relay', ...rows.map(r => [r.timestamp,r.source,r.voltage,r.current,r.power,r.energy,r.relay?'ON':'OFF'].map(quote).join(','))].join('\r\n');
}
