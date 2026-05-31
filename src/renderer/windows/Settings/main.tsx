import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme, applyThemeAttributes } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { getSoundScheme, setSoundScheme } from '../../sounds/synth';
import type { SoundScheme } from '../../sounds/synth';
import type { Theme } from '@shared/schemas';
import type { UpdateStatus } from '@shared/types';

type Section = 'themes' | 'sounds' | 'audio' | 'updates' | 'backup' | 'transfers' | 'about';

function App(): JSX.Element {
  const [section, setSection] = useState<Section>('themes');

  useEffect(() => {
    void applyPlatformTheme(window.buzz);
  }, []);

  return (
    <div className="aim-window" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <WindowChrome title="Settings" canMaximize={false} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* ── Left nav ── */}
        <div className="settings-nav">
          {(['themes', 'sounds', 'audio', 'updates', 'backup', 'transfers', 'about'] as Section[]).map((s) => (
            <button
              key={s}
              className={`settings-nav-item${section === s ? ' active' : ''}`}
              onClick={() => setSection(s)}
            >
              {s === 'themes' ? '🎨 Themes' : s === 'sounds' ? '🔊 Sounds' : s === 'audio' ? '🎙 Audio' : s === 'updates' ? '🔄 Updates' : s === 'backup' ? '💾 Backup' : s === 'transfers' ? '📁 Transfers' : 'ℹ️ About'}
            </button>
          ))}
        </div>
        {/* ── Content pane ── */}
        <div className="settings-content">
          {section === 'themes' && <ThemesPane />}
          {section === 'sounds' && <SoundsPane />}
          {section === 'audio' && <AudioPane />}
          {section === 'updates' && <UpdatesPane />}
          {section === 'backup' && <BackupPane />}
          {section === 'transfers' && <TransfersPane />}
          {section === 'about' && <AboutPane />}
        </div>
      </div>
    </div>
  );
}

/* ── Themes pane (from ThemeSettings) ─────────────────────────────────────── */

function ThemesPane(): JSX.Element {
  const [t, setT] = useState<Theme | null>(null);
  const didMount = useRef(false);

  useEffect(() => {
    void window.buzz.getPrefs().then((p) => setT(p.theme));
  }, []);

  useEffect(() => {
    if (!t) return;
    applyThemeAttributes(t);
    // Don't save on the initial load — only save when the user actually changes something.
    if (!didMount.current) { didMount.current = true; return; }
    void window.buzz.setPrefs({ theme: t }).catch(() => undefined);
  }, [t]);

  if (!t) return <div className="muted">Loading…</div>;

  function update<K extends keyof Theme>(k: K, v: Theme[K]): void {
    setT((prev) => (prev ? { ...prev, [k]: v } : prev));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="label">Color mode</div>
      <div className="row" style={{ gap: 8 }}>
        {(['light', 'dark'] as const).map((cm) => (
          <label key={cm}>
            <input type="radio" name="cm" checked={(t.colorMode ?? 'light') === cm} onChange={() => update('colorMode', cm)} />{' '}
            {cm === 'light' ? '☀ Light' : '🌙 Dark'}
          </label>
        ))}
      </div>

      <div className="label" style={{ marginTop: 6 }}>Window theme</div>
      <div className="row" style={{ gap: 8 }}>
        {(['classic', 'aqua', 'graphite', 'aero', 'metal', 'aluminum'] as const).map((wt) => (
          <label key={wt}>
            <input type="radio" name="wt" checked={t.windowTheme === wt} onChange={() => update('windowTheme', wt)} />{' '}
            {wt.charAt(0).toUpperCase() + wt.slice(1)}
          </label>
        ))}
      </div>

      <div className="label" style={{ marginTop: 6 }}>Chat style</div>
      <div className="row" style={{ gap: 8 }}>
        {(['classic', 'balloons', 'compact'] as const).map((ct) => (
          <label key={ct}>
            <input type="radio" name="ct" checked={t.chatTheme === ct} onChange={() => update('chatTheme', ct)} />{' '}
            {ct.charAt(0).toUpperCase() + ct.slice(1)}
          </label>
        ))}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <div style={{ flex: 1 }}>
          <div className="label">My bubble color</div>
          <input type="color" value={t.myBubbleColor} onChange={(e) => update('myBubbleColor', e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <div className="label">Their bubble color</div>
          <input type="color" value={t.theirBubbleColor} onChange={(e) => update('theirBubbleColor', e.target.value)} />
        </div>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <label>
          <input type="checkbox" checked={t.showTimestamps} onChange={(e) => update('showTimestamps', e.target.checked)} />{' '}
          Show timestamps
        </label>
        <label>
          <input type="checkbox" checked={t.showAvatarsInChat} onChange={(e) => update('showAvatarsInChat', e.target.checked)} />{' '}
          Show avatars in chat
        </label>
      </div>

      {/* Preview */}
      <div className="label" style={{ marginTop: 6 }}>Preview</div>
      <div className="bevel-in" style={{ height: 96, overflow: 'hidden' }}>
        <div className="chat-log" style={{ height: '100%' }} data-chat-theme-preview={t.chatTheme}>
          {t.chatTheme === 'balloons' ? (
            <>
              <div className="bubble-row in">
                <div className="bubble-avatar" />
                <div className="bubble" style={{ background: t.colorMode === 'dark' ? '#2a2a3e' : t.theirBubbleColor }}>Hey there!</div>
              </div>
              <div className="bubble-row out">
                <div className="bubble-avatar" />
                <div className="bubble" style={{ background: t.colorMode === 'dark' ? '#1e3a5f' : t.myBubbleColor }}>Hi — long time no talk.</div>
              </div>
            </>
          ) : t.chatTheme === 'compact' ? (
            <>
              <div style={{ fontSize: 11 }}><b style={{ color: '#0000b0' }}>buddy:</b> Hey there!</div>
              <div style={{ fontSize: 11 }}><b style={{ color: '#b00000' }}>you:</b> Hi — long time no talk.</div>
            </>
          ) : (
            <>
              <div><span className="them">buddy:</span> Hey there!</div>
              <div><span className="me">you:</span> Hi — long time no talk.</div>
            </>
          )}
        </div>
      </div>

    </div>
  );
}

/* ── Sounds pane ───────────────────────────────────────────────────────────── */

function SoundsPane(): JSX.Element {
  const [scheme, setSchemeState] = useState<SoundScheme>(getSoundScheme());
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.buzz.getPrefs().then((p) => {
      setSchemeState(p.soundScheme);
      setEnabled(p.soundsEnabled);
    });
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      setSoundScheme(scheme);
      await window.buzz.setPrefs({ soundScheme: scheme, soundsEnabled: enabled });
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="label">Sound scheme</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input type="radio" name="ss" checked={scheme === 'buzz'} onChange={() => { setSchemeState('buzz'); setSaved(false); }} />
        <span><strong>Buzz</strong> — synthesized tones</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input type="radio" name="ss" checked={scheme === 'classic'} onChange={() => { setSchemeState('classic'); setSaved(false); }} />
        <span><strong>Classic</strong> — authentic AIM sounds</span>
      </label>

      <div className="label" style={{ marginTop: 6 }}>Options</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }} />
        <span>Sounds enabled</span>
      </label>

      <div className="actions">
        <button onClick={() => void save()} disabled={busy}>Save</button>
        {saved && <span style={{ fontSize: 11, color: 'green' }}>Saved!</span>}
      </div>
    </div>
  );
}

/* ── Audio pane ────────────────────────────────────────────────────────────── */

type AudioDevice = { deviceId: string; label: string };

function AudioPane(): JSX.Element {
  const [micId, setMicId] = useState('');
  const [speakerId, setSpeakerId] = useState('');
  const [inputGain, setInputGain] = useState(1);
  const [outputGain, setOutputGain] = useState(1);
  const [pttKey, setPttKey] = useState('b');
  const [noiseSuppression, setNoiseSuppression] = useState(true);
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [micDevices, setMicDevices] = useState<AudioDevice[]>([]);
  const [speakerDevices, setSpeakerDevices] = useState<AudioDevice[]>([]);
  const [capturingPtt, setCapturingPtt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.buzz.getPrefs().then((p) => {
      setMicId(p.micDeviceId ?? '');
      setSpeakerId(p.speakerDeviceId ?? '');
      setInputGain(p.inputGain ?? 1);
      setOutputGain(p.outputGain ?? 1);
      setPttKey(p.pttKey ?? 'b');
      setNoiseSuppression(p.noiseSuppression ?? true);
      setEchoCancellation(p.echoCancellation ?? true);
      setNotificationsEnabled(p.notificationsEnabled ?? true);
    });
    // Enumerate audio devices (requires permissions on some platforms).
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      setMicDevices(
        devices
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId })),
      );
      setSpeakerDevices(
        devices
          .filter((d) => d.kind === 'audiooutput')
          .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId })),
      );
    });
  }, []);

  useEffect(() => {
    if (!capturingPtt) return;
    function onKey(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      setPttKey(e.key);
      setCapturingPtt(false);
      setSaved(false);
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturingPtt]);

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await window.buzz.setPrefs({
        micDeviceId: micId,
        speakerDeviceId: speakerId,
        inputGain,
        outputGain,
        pttKey,
        noiseSuppression,
        echoCancellation,
        notificationsEnabled,
      });
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  const rowStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Notifications ── */}
      <div className="label">Notifications</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={notificationsEnabled}
          onChange={(e) => { setNotificationsEnabled(e.target.checked); setSaved(false); }}
        />
        Enable desktop notifications for new messages
      </label>

      {/* ── Devices ── */}
      <div className="label" style={{ marginTop: 4 }}>Audio devices</div>
      <div style={rowStyle}>
        <span style={{ fontSize: 11 }}>Microphone</span>
        <select
          style={{ fontSize: 11 }}
          value={micId}
          onChange={(e) => { setMicId(e.target.value); setSaved(false); }}
        >
          <option value="">Default</option>
          {micDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        <span style={{ fontSize: 11 }}>Speaker / output</span>
        <select
          style={{ fontSize: 11 }}
          value={speakerId}
          onChange={(e) => { setSpeakerId(e.target.value); setSaved(false); }}
        >
          <option value="">Default</option>
          {speakerDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* ── Gain ── */}
      <div className="label" style={{ marginTop: 4 }}>Volume</div>
      <div style={rowStyle}>
        <span style={{ fontSize: 11 }}>Mic gain: {Math.round(inputGain * 100)}%</span>
        <input
          type="range" min={0} max={200} step={5}
          value={Math.round(inputGain * 100)}
          onChange={(e) => { setInputGain(Number(e.target.value) / 100); setSaved(false); }}
        />
      </div>
      <div style={rowStyle}>
        <span style={{ fontSize: 11 }}>Output gain: {Math.round(outputGain * 100)}%</span>
        <input
          type="range" min={0} max={200} step={5}
          value={Math.round(outputGain * 100)}
          onChange={(e) => { setOutputGain(Number(e.target.value) / 100); setSaved(false); }}
        />
      </div>

      {/* ── Processing ── */}
      <div className="label" style={{ marginTop: 4 }}>Processing</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input type="checkbox" checked={noiseSuppression} onChange={(e) => { setNoiseSuppression(e.target.checked); setSaved(false); }} />
        Noise suppression
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input type="checkbox" checked={echoCancellation} onChange={(e) => { setEchoCancellation(e.target.checked); setSaved(false); }} />
        Echo cancellation
      </label>

      {/* ── PTT key ── */}
      <div className="label" style={{ marginTop: 4 }}>Push-to-talk key</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: 'monospace',
            padding: '2px 8px',
            border: '1px solid #888',
            borderRadius: 3,
            background: '#eee',
            fontSize: 13,
            minWidth: 24,
            textAlign: 'center',
          }}
        >
          {pttKey}
        </span>
        <button
          onClick={() => setCapturingPtt(true)}
          style={{ fontSize: 11 }}
        >
          {capturingPtt ? 'Press any key…' : 'Change'}
        </button>
      </div>

      <div className="actions" style={{ marginTop: 4 }}>
        <button onClick={() => void save()} disabled={busy}>Save</button>
        {saved && <span style={{ fontSize: 11, color: 'green' }}>Saved!</span>}
      </div>
    </div>
  );
}

/* ── Updates pane ──────────────────────────────────────────────────────────── */

function UpdatesPane(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle' });
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    void window.buzz.updatesGetStatus().then(setStatus).catch(() => undefined);
    void window.buzz.updatesGetVersion().then(setAppVersion).catch(() => undefined);
    const off = window.buzz.onUpdateStatus((s: UpdateStatus) => setStatus(s));
    return () => { off(); };
  }, []);

  function statusLine(): string {
    switch (status.phase) {
      case 'idle': return appVersion ? `Version ${appVersion}` : 'Up to date';
      case 'checking': return 'Checking for updates…';
      case 'not-available': return `Up to date (${status.currentVersion})`;
      case 'available': return `Update available: v${status.version}`;
      case 'available-external': return status.version
        ? `Update available: v${status.version} — download from GitHub`
        : 'Update available — download from GitHub';
      case 'downloading': return `Downloading… ${status.percent}%`;
      case 'downloaded': return `v${status.version} ready to install`;
      case 'error': return `Error: ${status.message}`;
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="settings-section">
        <div className="settings-section-title">Auto-Updates</div>
        <div className="settings-status-line">{statusLine()}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {(status.phase === 'idle' || status.phase === 'not-available' || status.phase === 'error') && (
            <button onClick={() => { void window.buzz.updatesCheck().then(setStatus); }}>Check Now</button>
          )}
          {status.phase === 'available' && (
            <button onClick={() => { void window.buzz.updatesDownload().then(() => undefined); }}>Download Update</button>
          )}
          {status.phase === 'available-external' && (
            <button onClick={() => { void window.buzz.updatesOpenReleasePage(); }}>Open Download Page</button>
          )}
          {status.phase === 'downloaded' && (
            <button onClick={() => { void window.buzz.updatesInstall(); }}>Install &amp; Restart</button>
          )}
        </div>
        <div style={{ fontSize: 11, opacity: 0.65, marginTop: 6 }}>
          Updates are downloaded from the official GitHub Releases page and verified by a cryptographic hash before install.
        </div>
      </div>
    </div>
  );
}

function BackupPane(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function run(fn: () => Promise<{ ok: boolean; path?: string; cancelled?: true }>, label: string): Promise<void> {
    setBusy(true);
    setMsg('');
    try {
      const r = await fn();
      if (r.ok && r.path) setMsg(`${label} saved to ${r.path}`);
      else if (!r.ok && r.cancelled) setMsg('');
      else setMsg(`${label} failed.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : `${label} failed.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-pane">
      <div className="settings-section">
        <div className="settings-section-title">Account Backup</div>
        <p style={{ fontSize: 12, opacity: 0.85, marginTop: 0 }}>
          Exports your keystore and encrypted database into a single
          <code> .buzzbackup </code>file. You will still need your passphrase to sign in
          after restoring on another machine.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button disabled={busy} onClick={() => void run(() => window.buzz.exportBackup(), 'Backup')}>
            Export Backup…
          </button>
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">Message History</div>
        <p style={{ fontSize: 12, opacity: 0.85, marginTop: 0 }}>
          Exports all 1:1 message history as plaintext. Keep these files somewhere safe.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button disabled={busy} onClick={() => void run(() => window.buzz.exportHistoryJson(), 'History (JSON)')}>
            Export as JSON…
          </button>
          <button disabled={busy} onClick={() => void run(() => window.buzz.exportHistoryCsv(), 'History (CSV)')}>
            Export as CSV…
          </button>
        </div>
      </div>
      {msg && <div style={{ fontSize: 11, opacity: 0.8, marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

type TransferRowUi = Awaited<ReturnType<typeof window.buzz.listTransfers>>[number];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function TransfersPane(): JSX.Element {
  const [rows, setRows] = useState<TransferRowUi[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function refresh(): Promise<void> {
    setRows(await window.buzz.listTransfers());
  }
  useEffect(() => { void refresh(); }, []);
  async function retry(t: TransferRowUi): Promise<void> {
    if (!t.savedPath) { setMsg('No source path on record to retry.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await window.buzz.xferOffer(t.peerId, t.savedPath);
      if (r.cancelled) setMsg('Retry cancelled.');
      else setMsg(`Retry sent: ${r.fileName}`);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Retry failed.');
    } finally { setBusy(false); }
  }
  return (
    <div className="settings-pane">
      <div className="settings-section">
        <div className="settings-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Transfer History</span>
          <button onClick={() => void refresh()} disabled={busy}>Refresh</button>
        </div>
        {rows.length === 0 && <p style={{ fontSize: 12, opacity: 0.7 }}>No transfers yet.</p>}
        {rows.length > 0 && (
          <div style={{ maxHeight: 360, overflow: 'auto', border: '1px solid var(--c-bevel-dark, #888)' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--c-panel)' }}>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>Dir</th>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>Peer</th>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>File</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px' }}>Size</th>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '4px 6px' }}>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} style={{ borderTop: '1px solid var(--c-bevel-light, #ccc)' }}>
                    <td style={{ padding: '4px 6px' }}>{t.direction === 'in' ? '↓' : '↑'}</td>
                    <td style={{ padding: '4px 6px' }}>{t.alias || t.peerId.slice(0, 10) + '…'}</td>
                    <td style={{ padding: '4px 6px' }}>{t.fileName}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right' }}>{formatBytes(t.fileSize)}</td>
                    <td style={{ padding: '4px 6px' }}>{t.status}</td>
                    <td style={{ padding: '4px 6px' }}>{new Date(t.createdAt).toLocaleString()}</td>
                    <td style={{ padding: '4px 6px' }}>
                      {t.direction === 'out' && (t.status === 'failed' || t.status === 'declined') && (
                        <button disabled={busy} onClick={() => void retry(t)}>Retry</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {msg && <div style={{ fontSize: 11, opacity: 0.8, marginTop: 8 }}>{msg}</div>}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

/* ── About pane (version + opt-in local telemetry) ─────────────────────── */

function AboutPane(): JSX.Element {
  const [version, setVersion] = useState<string>('');
  const [enabled, setEnabled] = useState<boolean>(false);
  const [t, setT] = useState<{
    imsSent: number;
    callsTotal: number;
    callMillis: number;
    voiceJoins: number;
    screenShares: number;
    sinceTs: number;
  } | null>(null);

  async function refresh(): Promise<void> {
    const [v, p, snap] = await Promise.all([
      window.buzz.getAppVersion(),
      window.buzz.getPrefs(),
      window.buzz.getTelemetry(),
    ]);
    setVersion(v);
    setEnabled(p.telemetryEnabled);
    setT(snap);
  }

  useEffect(() => { void refresh(); }, []);

  async function toggle(next: boolean): Promise<void> {
    setEnabled(next);
    await window.buzz.setPrefs({ telemetryEnabled: next });
  }
  async function reset(): Promise<void> {
    const snap = await window.buzz.resetTelemetry();
    setT(snap);
  }

  const fmtMins = (ms: number): string => `${Math.round(ms / 60000)} min`;
  const since = t && t.sinceTs ? new Date(t.sinceTs).toLocaleString() : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="label">About</div>
      <div style={{ fontSize: 12 }}>
        <div><b>Buzz</b> v{version || '…'}</div>
        <div style={{ opacity: 0.7, marginTop: 4 }}>
          Crash dumps (if any) are written to your local user-data folder under <code>crashes/</code> and are never uploaded.
        </div>
      </div>

      <div className="label" style={{ marginTop: 8 }}>Local usage stats</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void toggle(e.target.checked)}
        />
        Count my own usage locally (nothing is ever uploaded)
      </label>

      {enabled && t && (
        <table style={{ fontSize: 12, borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={{ paddingRight: 12, opacity: 0.7 }}>IMs sent</td><td>{t.imsSent}</td></tr>
            <tr><td style={{ paddingRight: 12, opacity: 0.7 }}>1:1 calls</td><td>{t.callsTotal} ({fmtMins(t.callMillis)})</td></tr>
            <tr><td style={{ paddingRight: 12, opacity: 0.7 }}>Voice channel joins</td><td>{t.voiceJoins}</td></tr>
            <tr><td style={{ paddingRight: 12, opacity: 0.7 }}>Screen shares started</td><td>{t.screenShares}</td></tr>
            <tr><td style={{ paddingRight: 12, opacity: 0.7 }}>Counting since</td><td>{since}</td></tr>
          </tbody>
        </table>
      )}
      {enabled && (
        <div>
          <button onClick={() => void reset()}>Reset counters</button>
        </div>
      )}
    </div>
  );
}