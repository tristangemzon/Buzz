// Tap-to-record voice memo button.
// Captures mic via MediaRecorder (Opus/WebM), stages the blob in
// userData/voice/, then calls xferOffer(peerId, stagedPath) to send via
// the existing file-transfer pipeline.

import { useEffect, useRef, useState } from 'react';

type Props = {
  peerId: string;
  disabled?: boolean;
  peerOnline?: boolean;
  onError?: (msg: string) => void;
  onSent?: (info: { id: string; fileName: string; fileSize: number }) => void;
};

const MIME = 'audio/webm;codecs=opus';
const MAX_DURATION_MS = 5 * 60 * 1000;

export function VoiceMemo({ peerId, disabled, peerOnline, onError, onSent }: Props): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<number | null>(null);

  useEffect(() => () => { stopAll(); }, []);

  function stopAll(): void {
    try { recRef.current?.stop(); } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  async function start(): Promise<void> {
    if (recording || disabled) return;
    try {
      if (!('MediaRecorder' in window) || !MediaRecorder.isTypeSupported(MIME)) {
        throw new Error('Opus/WebM not supported on this device');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 32_000 });
      recRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => { void finalize(); };
      rec.start(250);
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      tickRef.current = window.setInterval(() => {
        const ms = Date.now() - startedAtRef.current;
        setElapsed(ms);
        if (ms >= MAX_DURATION_MS) stop();
      }, 200);
    } catch (e) {
      stopAll();
      setRecording(false);
      onError?.(e instanceof Error ? e.message : 'Microphone unavailable');
    }
  }

  function stop(): void {
    if (!recording) return;
    setRecording(false);
    try { recRef.current?.stop(); } catch { /* ignore */ }
  }

  function cancel(): void {
    chunksRef.current = [];
    setRecording(false);
    stopAll();
  }

  async function finalize(): Promise<void> {
    const chunks = chunksRef.current.slice();
    chunksRef.current = [];
    stopAll();
    if (chunks.length === 0) return;
    try {
      const blob = new Blob(chunks, { type: MIME });
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (buf.byteLength < 256) {
        onError?.('Voice memo too short');
        return;
      }
      const staged = await window.buzz.stageVoice(buf, 'webm');
      if (peerOnline === false && buf.byteLength <= 256 * 1024) {
        // Peer is offline; embed memo into a sealed mailbox envelope so the
        // recipient gets it next time they come online.
        const r = await window.buzz.sendMailboxMedia({
          toPeerId: peerId,
          stagedPath: staged.filePath,
          mime: MIME,
          fileName: staged.fileName,
        });
        if (r.ok) onSent?.({ id: r.id, fileName: staged.fileName, fileSize: buf.byteLength });
        else onError?.('No mailbox relay accepted the memo.');
        return;
      }
      const r = await window.buzz.xferOffer(peerId, staged.filePath);
      if (!r.cancelled) onSent?.({ id: r.id, fileName: r.fileName, fileSize: r.fileSize });
    } catch (e) {
      onError?.(e instanceof Error ? e.message : 'Failed to send voice memo');
    }
  }

  const secs = Math.floor(elapsed / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(1, '0');
  const ss = String(secs % 60).padStart(2, '0');

  if (recording) {
    return (
      <span className="im-voice-recording" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <button className="im-action-btn" onClick={cancel} title="Cancel recording">
          <span className="im-action-btn-icon">✖</span>
          <span className="im-action-btn-label">Cancel</span>
        </button>
        <button className="im-action-btn" onClick={stop} title="Stop & send">
          <span className="im-action-btn-icon" style={{ color: '#d33' }}>●</span>
          <span className="im-action-btn-label">{mm}:{ss}</span>
        </button>
      </span>
    );
  }
  return (
    <button
      className="im-action-btn"
      onClick={() => void start()}
      disabled={disabled}
      title="Record a voice memo"
    >
      <span className="im-action-btn-icon">🎤</span>
      <span className="im-action-btn-label">Memo</span>
    </button>
  );
}
