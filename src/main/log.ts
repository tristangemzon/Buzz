// Log redaction for production builds.
//
// Scrubs PeerIds (libp2p base58btc, 46–54 chars starting "12D3Koo" or "Qm"),
// IPv4 addresses, and obvious IPv6 addresses from anything that hits the main
// process's console.* sinks. Screen names are NOT redacted here — they are
// user-chosen and not considered PII once the user has joined a room.
//
// The patch is one-shot and idempotent; calling installRedactedConsole twice
// is harmless.

const PEER_ID_RE = /\b(12D3Koo[1-9A-HJ-NP-Za-km-z]{45,50}|Qm[1-9A-HJ-NP-Za-km-z]{44})\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Minimal IPv6 matcher — covers full + :: compressed forms by allowing empty
// hex groups (the part between consecutive colons in ::).
const IPV6_RE = /(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{1,4}/g;

export function redact(value: unknown): string {
  if (value == null) return String(value);
  let s: string;
  if (typeof value === 'string') s = value;
  else if (value instanceof Error) s = `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  return s
    .replace(PEER_ID_RE, (m) => `<peer:${m.slice(-6)}>`)
    .replace(IPV4_RE, '<ipv4>')
    .replace(IPV6_RE, '<ipv6>');
}

let installed = false;
export function installRedactedConsole(): void {
  if (installed) return;
  installed = true;
  const wrap = (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => fn(...args.map(redact));
  // eslint-disable-next-line no-console
  console.log = wrap(console.log.bind(console));
  // eslint-disable-next-line no-console
  console.info = wrap(console.info.bind(console));
  // eslint-disable-next-line no-console
  console.warn = wrap(console.warn.bind(console));
  // eslint-disable-next-line no-console
  console.error = wrap(console.error.bind(console));
}
