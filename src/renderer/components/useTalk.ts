// Voice-call client: encapsulates microphone capture (MediaRecorder → opus
// chunks) and playback (MediaSource SourceBuffer fed by inbound chunks),
// plus tiny React hook to drive the IM window's call UI.
//
// Wire format is opaque WebM/Opus chunks; the main process just relays them.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TalkCallState } from '@shared/schemas';
import { playSound } from '../sounds/synth';

const MIME = 'audio/webm;codecs=opus';
const TIMESLICE_MS = 80;

class CaptureSink {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private muted = false;

  async start(send: (data: Uint8Array) => void): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    if (!('MediaRecorder' in window)) throw new Error('MediaRecorder not supported');
    if (!MediaRecorder.isTypeSupported(MIME)) throw new Error('Opus/WebM not supported');
    const rec = new MediaRecorder(stream, { mimeType: MIME });
    rec.ondataavailable = async (e) => {
      if (this.muted) return;
      if (e.data && e.data.size > 0) {
        try {
          const buf = new Uint8Array(await e.data.arrayBuffer());
          send(buf);
        } catch {
          /* ignore */
        }
      }
    };
    rec.start(TIMESLICE_MS);
    this.rec = rec;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    // Also disable the mic track so the OS indicator can reflect it.
    if (this.stream) {
      for (const t of this.stream.getAudioTracks()) t.enabled = !m;
    }
  }

  stop(): void {
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    } catch {
      /* ignore */
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.rec = null;
    this.stream = null;
  }
}

class PlaybackSink {
  private audio: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private opened = false;
  private url: string | null = null;

  start(): void {
    this.stop();
    if (typeof MediaSource === 'undefined') return;
    if (!MediaSource.isTypeSupported(MIME)) return;
    const audio = document.createElement('audio');
    audio.autoplay = true;
    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    audio.src = url;
    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer(MIME);
        sb.addEventListener('updateend', () => this.drain());
        this.sourceBuffer = sb;
        this.opened = true;
        this.drain();
        // Force playback (autoplay can be blocked even on Electron in rare cases).
        void audio.play().catch(() => undefined);
      } catch {
        /* ignore */
      }
    });
    document.body.appendChild(audio);
    this.audio = audio;
    this.mediaSource = ms;
    this.url = url;
  }

  push(data: Uint8Array): void {
    // Copy into a fresh ArrayBuffer so SourceBuffer's appendBuffer accepts it
    // (lib.dom requires ArrayBuffer-backed BufferSource).
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    this.queue.push(buf);
    if (this.opened) this.drain();
  }

  private drain(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      sb.appendBuffer(next);
    } catch {
      // Reset on quota / decode errors so we don't get stuck.
      this.queue.length = 0;
    }
  }

  stop(): void {
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {
        /* ignore */
      }
      this.audio.remove();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.audio = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.opened = false;
    this.url = null;
  }
}

export type CallUi = {
  call: TalkCallState | null;
  muted: boolean;
  error: string;
  elapsedSec: number;
  startCall: () => Promise<void>;
  acceptIncoming: () => Promise<void>;
  rejectIncoming: () => Promise<void>;
  endCall: () => Promise<void>;
  toggleMute: () => void;
};

// Hook bound to a single peer. The main process tracks at most one global call
// at a time, so this hook only fires for events whose peerId matches.
export function useTalk(peerId: string): CallUi {
  const [call, setCall] = useState<TalkCallState | null>(null);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const capture = useMemo(() => new CaptureSink(), []);
  const playback = useMemo(() => new PlaybackSink(), []);
  const ringTimer = useRef<number | null>(null);

  // On mount, sync any in-progress call state for this peer.
  useEffect(() => {
    let cancelled = false;
    void window.buzz
      .talkGetActive(peerId)
      .then((s) => {
        if (cancelled) return;
        if (s && s.peerId === peerId && s.state !== 'ended') setCall(s);
      })
      .catch(() => undefined);

    const offInvite = window.buzz.onTalkInvite((e) => {
      if (e.peerId !== peerId) return;
      setCall(e);
    });
    const offState = window.buzz.onTalkState((e) => {
      if (e.peerId !== peerId) return;
      setCall(e.state === 'ended' ? null : e);
    });
    const offEnded = window.buzz.onTalkEnded((e) => {
      if (e.peerId !== peerId) return;
      setCall(null);
      setError(e.reason ? `Call ended: ${e.reason}` : '');
    });
    const offAudio = window.buzz.onTalkAudio((e) => {
      if (e.peerId !== peerId) return;
      playback.push(e.data);
    });

    return () => {
      cancelled = true;
      offInvite();
      offState();
      offEnded();
      offAudio();
      capture.stop();
      playback.stop();
      if (ringTimer.current !== null) {
        window.clearInterval(ringTimer.current);
        ringTimer.current = null;
      }
    };
  }, [peerId, capture, playback]);

  // Drive ringing sound on the callee side.
  useEffect(() => {
    if (call?.state === 'ringing' && call.role === 'callee') {
      playSound('ring');
      const id = window.setInterval(() => playSound('ring'), 1200);
      ringTimer.current = id;
      return () => {
        window.clearInterval(id);
        if (ringTimer.current === id) ringTimer.current = null;
      };
    }
    return undefined;
  }, [call?.state, call?.role]);

  // Start audio capture + playback once active.
  useEffect(() => {
    if (call?.state !== 'active') {
      capture.stop();
      playback.stop();
      return;
    }
    playback.start();
    let cancelled = false;
    void capture
      .start(async (data) => {
        if (cancelled) return;
        try {
          await window.buzz.talkSendAudio(call.callId, data);
        } catch {
          /* peer disconnected; main side will drop call */
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Microphone unavailable');
        void window.buzz.talkEnd(call.callId).catch(() => undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [call?.state, call?.callId, capture, playback]);

  // Apply mute changes to the live capture.
  useEffect(() => {
    capture.setMuted(muted);
  }, [muted, capture]);

  // Tick a counter while active.
  useEffect(() => {
    if (call?.state !== 'active' || !call.startedAt) {
      setElapsedSec(0);
      return undefined;
    }
    const tick = () => setElapsedSec(Math.max(0, Math.floor((Date.now() - (call.startedAt ?? 0)) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [call?.state, call?.startedAt]);

  return {
    call,
    muted,
    error,
    elapsedSec,
    startCall: async () => {
      setError('');
      try {
        await window.buzz.talkInvite(peerId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to start call');
      }
    },
    acceptIncoming: async () => {
      setError('');
      if (!call) return;
      try {
        await window.buzz.talkAccept(call.callId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to accept');
      }
    },
    rejectIncoming: async () => {
      if (!call) return;
      try {
        await window.buzz.talkReject(call.callId);
      } catch {
        /* ignore */
      }
    },
    endCall: async () => {
      if (!call) return;
      try {
        await window.buzz.talkEnd(call.callId);
      } catch {
        /* ignore */
      }
    },
    toggleMute: () => setMuted((m) => !m),
  };
}

export function fmtCallTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
