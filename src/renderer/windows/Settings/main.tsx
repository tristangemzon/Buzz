import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme, applyThemeAttributes } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { getSoundScheme, setSoundScheme } from '../../sounds/synth';
import type { SoundScheme } from '../../sounds/synth';
import type { Theme } from '@shared/schemas';
import type { UpdateStatus } from '@shared/types';

type Section = 'themes' | 'sounds' | 'updates';

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
          {(['themes', 'sounds', 'updates'] as Section[]).map((s) => (
            <button
              key={s}
              className={`settings-nav-item${section === s ? ' active' : ''}`}
              onClick={() => setSection(s)}
            >
              {s === 'themes' ? '🎨 Themes' : s === 'sounds' ? '🔊 Sounds' : '🔄 Updates'}
            </button>
          ))}
        </div>
        {/* ── Content pane ── */}
        <div className="settings-content">
          {section === 'themes' && <ThemesPane />}
          {section === 'sounds' && <SoundsPane />}
          {section === 'updates' && <UpdatesPane />}
        </div>
      </div>
    </div>
  );
}

/* ── Themes pane (from ThemeSettings) ─────────────────────────────────────── */

function ThemesPane(): JSX.Element {
  const [t, setT] = useState<Theme | null>(null);

  useEffect(() => {
    void window.buzz.getPrefs().then((p) => setT(p.theme));
  }, []);

  useEffect(() => {
    if (t) {
      applyThemeAttributes(t);
      void window.buzz.setPrefs({ theme: t }).catch(() => undefined);
    }
  }, [t]);

  if (!t) return <div className="muted">Loading…</div>;

  function update<K extends keyof Theme>(k: K, v: Theme[K]): void {
    setT((prev) => (prev ? { ...prev, [k]: v } : prev));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="label">Window theme</div>
      <div className="row" style={{ gap: 8 }}>
        {(['classic', 'aqua', 'graphite'] as const).map((wt) => (
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
                <div className="bubble" style={{ background: t.theirBubbleColor }}>Hey there!</div>
              </div>
              <div className="bubble-row out">
                <div className="bubble-avatar" />
                <div className="bubble" style={{ background: t.myBubbleColor }}>Hi — long time no talk.</div>
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

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
