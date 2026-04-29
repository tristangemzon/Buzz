// Voice-channel hook. Joins/leaves a room voice channel, captures the mic,
// and plays back audio from every other joined participant via per-peer
// MediaSource sinks. Uses the existing room-voice IPC bridge.

import { useCallback, useEffect, useRef, useState } from 'react';

const MIME_OPUS_WEBM = 'audio/webm;codecs=opus';

class VoicePlaybackSink {
  readonly audio: HTMLAudioElement;
  private ms: MediaSource;
  private buf: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private alive = true;

  constructor() {
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.audio.volume = 1;
    this.ms = new MediaSource();
    this.audio.src = URL.createObjectURL(this.ms);
    this.ms.addEventListener('sourceopen', () => {
      if (!this.alive) return;
      try {
        const sb = this.ms.addSourceBuffer(MIME_OPUS_WEBM);
        sb.mode = 'sequence';
        sb.addEventListener('updateend', () => this.flush());
        this.buf = sb;
        this.flush();
      } catch {
        /* ignore */
      }
    });
    void this.audio.play().catch(() => undefined);
  }

  push(data: Uint8Array): void {
    this.queue.push(data);
    this.flush();
  }

  private flush(): void {
    if (!this.alive || !this.buf || this.buf.updating) return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      const copy = new Uint8Array(new ArrayBuffer(next.byteLength));
      copy.set(next);
      this.buf.appendBuffer(copy);
    } catch {
      // QuotaExceeded: drop the queue and keep going.
      this.queue = [];
    }
  }

  dispose(): void {
    this.alive = false;
    try {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch {
      /* ignore */
    }
  }
}

class VoiceCaptureSink {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;

  async start(onChunk: (data: Uint8Array) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.rec = new MediaRecorder(this.stream, {
      mimeType: MIME_OPUS_WEBM,
      audioBitsPerSecond: 24000,
    });
    this.rec.ondataavailable = async (e) => {
      if (!e.data || e.data.size === 0) return;
      const buf = new Uint8Array(await e.data.arrayBuffer());
      onChunk(buf);
    };
    this.rec.start(80);
  }

  setMuted(muted: boolean): void {
    if (!this.stream) return;
    for (const t of this.stream.getAudioTracks()) t.enabled = !muted;
  }

  stop(): void {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.rec = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
  }
}

export type RoomVoiceParticipant = {
  peerId: string;
  screenName: string;
};

export type RoomVoiceUi = {
  joined: boolean;
  muted: boolean;
  participants: RoomVoiceParticipant[];
  error: string | null;
  join: () => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => void;
};

export function useRoomVoice(roomId: string, channelId: string | null): RoomVoiceUi {
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [participants, setParticipants] = useState<RoomVoiceParticipant[]>([]);
  const [error, setError] = useState<string | null>(null);

  const captureRef = useRef<VoiceCaptureSink | null>(null);
  const sinksRef = useRef<Map<string, VoicePlaybackSink>>(new Map());
  const joinedRef = useRef(false);
  const channelRef = useRef<string | null>(null);
  channelRef.current = channelId;

  // Receive audio events: route to the right sink (one per peer).
  useEffect(() => {
    const off = window.buzz.onRoomVoiceAudio((e) => {
      if (e.roomId !== roomId || e.channelId !== channelRef.current) return;
      if (!joinedRef.current) return;
      let sink = sinksRef.current.get(e.peerId);
      if (!sink) {
        sink = new VoicePlaybackSink();
        sinksRef.current.set(e.peerId, sink);
      }
      sink.push(e.data);
    });
    return () => off();
  }, [roomId]);

  // Track presence.
  useEffect(() => {
    const off = window.buzz.onRoomVoicePresence((e) => {
      if (e.roomId !== roomId || e.channelId !== channelRef.current) return;
      setParticipants((prev) => {
        const next = prev.filter((p) => p.peerId !== e.peerId);
        if (e.joined) {
          next.push({ peerId: e.peerId, screenName: e.screenName ?? '' });
        } else {
          // Tear down their playback sink.
          const sink = sinksRef.current.get(e.peerId);
          if (sink) {
            sink.dispose();
            sinksRef.current.delete(e.peerId);
          }
        }
        return next;
      });
    });
    return () => off();
  }, [roomId]);

  // If we switch channels while joined, hang up.
  useEffect(() => {
    return () => {
      if (joinedRef.current && channelRef.current) {
        void window.buzz
          .roomVoiceLeave({ roomId, channelId: channelRef.current })
          .catch(() => undefined);
      }
      captureRef.current?.stop();
      captureRef.current = null;
      for (const s of sinksRef.current.values()) s.dispose();
      sinksRef.current.clear();
      joinedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, roomId]);

  // Reset participant list when the channel changes.
  useEffect(() => {
    setParticipants([]);
    setJoined(false);
    setMuted(false);
  }, [channelId]);

  const join = useCallback(async (): Promise<void> => {
    if (!channelId) return;
    setError(null);
    try {
      const cap = new VoiceCaptureSink();
      await cap.start((data) => {
        // Fire-and-forget; the main process will silently drop if not joined.
        void window.buzz.roomVoiceSendAudio({ roomId, channelId }, data);
      });
      captureRef.current = cap;
      joinedRef.current = true;
      setJoined(true);
      await window.buzz.roomVoiceJoin({ roomId, channelId });
    } catch (e) {
      setError(String((e as Error).message ?? e));
      captureRef.current?.stop();
      captureRef.current = null;
      joinedRef.current = false;
      setJoined(false);
    }
  }, [roomId, channelId]);

  const leave = useCallback(async (): Promise<void> => {
    if (!channelId) return;
    captureRef.current?.stop();
    captureRef.current = null;
    for (const s of sinksRef.current.values()) s.dispose();
    sinksRef.current.clear();
    joinedRef.current = false;
    setJoined(false);
    setMuted(false);
    await window.buzz.roomVoiceLeave({ roomId, channelId }).catch(() => undefined);
  }, [roomId, channelId]);

  const toggleMute = useCallback((): void => {
    setMuted((m) => {
      const next = !m;
      captureRef.current?.setMuted(next);
      return next;
    });
  }, []);

  return { joined, muted, participants, error, join, leave, toggleMute };
}
