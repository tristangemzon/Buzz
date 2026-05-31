// PresenceManager: owns local presence state (online/away/idle/invisible) and
// drives profile broadcasts to currently-connected peers via the IM protocol.
//
// Wire model:
//   - On peer:connect, push our profile to that peer (unless invisible).
//   - On peer:disconnect, emit a synthetic BuddyStatusEvent {status:'offline'}
//     to the renderer.
//   - On setStatus, push profile to all connected peers; persist baseStatus
//     (only 'online' / 'invisible') to prefs.
//   - Idle detection: poll powerMonitor.getSystemIdleTime() every IDLE_POLL_MS.
//     If base='online' and idle >= idleMinutes*60 → effective='idle' and
//     rebroadcast. On activity (idle<threshold) flip back to 'online'.
//   - Invisible: send a single profile {status:'offline'} to current peers
//     on entering invisible, then suppress further broadcasts.

import { powerMonitor } from 'electron';
import type { Libp2p } from '@libp2p/interface';
import type { ImService } from './im.js';
import type { Profile, Status, SelectableStatus, SelfPresence } from '@shared/schemas.js';

const IDLE_POLL_MS = 30_000;
// How long (ms) to wait after a peer:disconnect before broadcasting "offline"
// to the renderer. libp2p frequently closes/reopens connections during relay
// negotiation or connection-manager pruning — a brief debounce prevents the
// buddy-list from flickering while the two sides are actually still reachable.
const OFFLINE_DEBOUNCE_MS = 6_000;
// Interval at which we re-announce our own presence to every connected peer.
// Catches the case where the initial sendProfileTo after peer:connect was
// dropped (stream not yet open, relay not yet usable, etc.).
const REANNOUNCE_INTERVAL_MS = 10_000;
// Login burst: re-announce at these offsets (ms) after start() so we catch
// peers that are already online but connected before our stream was ready.
const LOGIN_BURST_DELAYS_MS = [2_000, 5_000, 12_000, 25_000];

export type BroadcastFn = (peerId: string, status: Status, awayMessage?: string) => void;
export type PrefsBridge = {
  getIdleMinutes(): number;
  getAwayMessage(): string;
  getLastStatus(): 'online' | 'dnd' | 'invisible';
  setLastStatus(s: 'online' | 'dnd' | 'invisible'): void;
  getProfile(): Profile;
};

export class PresenceManager {
  private base: SelectableStatus = 'online';
  private effective: Status = 'online';
  private awayMessage: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private reannounceTimer: NodeJS.Timeout | null = null;
  private burstTimers: NodeJS.Timeout[] = [];
  private started = false;
  // Track peers we have an active connection with so we can target broadcasts.
  private readonly connected = new Set<string>();
  // Pending debounced "offline" timers keyed by peerId.
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly node: Libp2p,
    private readonly im: ImService,
    private readonly screenName: () => string,
    private readonly prefs: PrefsBridge,
    private readonly broadcastToRenderer: BroadcastFn,
    // Optional: returns true when a peer is currently in a voice/video call.
    // When set, the offline debounce is extended for active-call peers so a
    // brief transport hiccup doesn't interrupt a call in progress.
    private readonly isInActiveCall: (peerId: string) => boolean = () => false,
    // Optional: invoked whenever our own SelfPresence changes (setStatus or
    // idle transition). Used by session.ts to fan-out EvtSelfPresence and
    // gate sound/notification subsystems on DND.
    private readonly onSelfChange: (self: SelfPresence) => void = () => undefined,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.base = this.prefs.getLastStatus();
    this.awayMessage = this.prefs.getAwayMessage() || undefined;
    if (this.base === 'invisible') this.effective = 'invisible';
    else if (this.base === 'dnd') this.effective = 'dnd';
    else this.effective = 'online';

    this.node.addEventListener('peer:connect', this.onPeerConnect);
    this.node.addEventListener('peer:disconnect', this.onPeerDisconnect);

    this.timer = setInterval(() => this.tickIdle(), IDLE_POLL_MS);
    this.reannounceTimer = setInterval(() => void this.broadcastToConnected(), REANNOUNCE_INTERVAL_MS);
    this.onSelfChange(this.getSelf());
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = null;
    }
    for (const t of this.burstTimers) clearTimeout(t);
    this.burstTimers = [];
    // Cancel any pending offline debounce timers — we're shutting down.
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
    this.node.removeEventListener('peer:connect', this.onPeerConnect);
    this.node.removeEventListener('peer:disconnect', this.onPeerDisconnect);
    // Best-effort: announce going offline to any connected peer.
    const targets = [...this.connected];
    this.connected.clear();
    await Promise.all(
      targets.map((p) => this.sendProfileTo(p, 'offline').catch(() => undefined)),
    );
  }

  getSelf(): SelfPresence {
    return {
      status: this.effective,
      baseStatus: this.base,
      awayMessage: this.awayMessage,
    };
  }

  // Schedule a burst of re-announces right after login to catch peers who were
  // already connected before our IM stream was ready.
  loginBurst(): void {
    for (const t of this.burstTimers) clearTimeout(t);
    this.burstTimers = LOGIN_BURST_DELAYS_MS.map((delay) =>
      setTimeout(() => void this.broadcastToConnected(), delay),
    );
  }

  // Re-broadcast the current effective status — used after the user edits their
  // profile so peers immediately see the new about text / colors / avatar.
  async rebroadcast(): Promise<void> {
    if (!this.started) return;
    await this.broadcastToConnected();
  }

  async setStatus(status: SelectableStatus, awayMessage?: string): Promise<SelfPresence> {
    const prevBase = this.base;
    const prevEff = this.effective;
    const prevAway = this.awayMessage;

    this.base = status;
    if (status === 'away') {
      this.awayMessage = awayMessage ?? (this.prefs.getAwayMessage() || undefined);
      this.effective = 'away';
    } else if (status === 'invisible') {
      this.awayMessage = undefined;
      this.effective = 'invisible';
    } else if (status === 'dnd') {
      this.awayMessage = undefined;
      this.effective = 'dnd';
    } else {
      // 'online' — preserve the away message in prefs but don't broadcast it.
      this.awayMessage = undefined;
      this.effective = 'online';
    }

    // Persist only the user-selectable persistent states.
    if (status === 'online' || status === 'invisible' || status === 'dnd') {
      this.prefs.setLastStatus(status);
    }

    // No-op if nothing actually changed.
    if (prevBase === this.base && prevEff === this.effective && prevAway === this.awayMessage) {
      return this.getSelf();
    }

    await this.broadcastToConnected();
    this.onSelfChange(this.getSelf());
    return this.getSelf();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private readonly onPeerConnect = (evt: Event): void => {
    const peerId = peerIdFromEvent(evt);
    if (!peerId) return;
    // Cancel any pending "offline" signal for this peer — they're back.
    const existing = this.offlineTimers.get(peerId);
    if (existing) {
      clearTimeout(existing);
      this.offlineTimers.delete(peerId);
    }
    this.connected.add(peerId);
    // Send our profile after connect (lazy: don't fail the event loop).
    void this.sendProfileTo(peerId, this.wireStatus()).catch(() => undefined);
  };

  private readonly onPeerDisconnect = (evt: Event): void => {
    const peerId = peerIdFromEvent(evt);
    if (!peerId) return;
    this.connected.delete(peerId);
    // Debounce: libp2p can fire a disconnect immediately before re-establishing
    // the connection via a different transport (relay → direct, etc.). Only
    // inform the renderer after a grace period to avoid flickering.
    // Use a longer grace period if we have an active call with this peer.
    if (this.offlineTimers.has(peerId)) return; // already pending
    const gracePeriod = this.isInActiveCall(peerId)
      ? OFFLINE_DEBOUNCE_MS * 3   // ~18 s during active calls
      : OFFLINE_DEBOUNCE_MS;      // ~6 s otherwise
    const t = setTimeout(() => {
      this.offlineTimers.delete(peerId);
      // Only fire if the peer is still not connected after the grace period.
      if (!this.connected.has(peerId)) {
        this.broadcastToRenderer(peerId, 'offline');
      }
    }, gracePeriod);
    this.offlineTimers.set(peerId, t);
  };

  private async tickIdle(): Promise<void> {
    if (!this.started) return;
    if (this.base !== 'online') return; // idle only applies in 'online' base
    const idleSec = powerMonitor.getSystemIdleTime();
    const threshold = Math.max(1, this.prefs.getIdleMinutes()) * 60;
    const wantIdle = idleSec >= threshold;
    const next: Status = wantIdle ? 'idle' : 'online';
    if (next !== this.effective) {
      this.effective = next;
      await this.broadcastToConnected();
      this.onSelfChange(this.getSelf());
    }
  }

  private wireStatus(): Status {
    // What we advertise on the wire. Invisible == offline to peers.
    return this.effective === 'invisible' ? 'offline' : this.effective;
  }

  private async broadcastToConnected(): Promise<void> {
    const wire = this.wireStatus();
    await Promise.all(
      [...this.connected].map((p) => this.sendProfileTo(p, wire).catch(() => undefined)),
    );
  }

  private async sendProfileTo(peerId: string, status: Status): Promise<void> {
    if (this.base === 'invisible' && status !== 'offline') return; // suppress
    const prof = this.prefs.getProfile();
    await this.im.send(peerId, {
      type: 'profile',
      screenName: this.screenName(),
      status,
      awayMessage: status === 'away' ? this.awayMessage : undefined,
      aboutText: prof.aboutText || undefined,
      textColor: prof.textColor || undefined,
      bgColor: prof.bgColor || undefined,
      fontFamily: prof.fontFamily || undefined,
      avatar: prof.avatarDataUrl || undefined,
      bgImage: prof.bgImageDataUrl || undefined,
    });
  }
}

function peerIdFromEvent(evt: Event): string | null {
  // libp2p's peer:connect / peer:disconnect events are CustomEvents whose
  // detail is a PeerId.
  const detail = (evt as CustomEvent).detail as { toString(): string } | undefined;
  if (!detail) return null;
  try {
    const s = detail.toString();
    return typeof s === 'string' && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}
