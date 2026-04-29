// "Themes" settings modal — controls the *local* look-and-feel:
// window chrome (Classic/Aqua/Graphite), chat layout (Classic/Balloons/Compact),
// bubble colors, timestamps, and avatars.
//
// All choices are persisted via `setPrefs({ theme })` and applied immediately
// via `applyThemeAttributes` so the user sees the change without restarting.

import React, { useEffect, useState } from 'react';
import type { Theme } from '@shared/schemas';
import { applyThemeAttributes } from '../theme/applyPlatform';

export function ThemeSettings(props: { onClose: () => void }): JSX.Element {
  const [t, setT] = useState<Theme | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    void window.buzz.getPrefs().then((p) => setT(p.theme));
  }, []);

  // Live-preview theme attributes as the user tweaks. We re-apply on every
  // change so the host window updates without a save round-trip.
  useEffect(() => {
    if (t) applyThemeAttributes(t);
  }, [t]);

  if (!t) {
    return (
      <Modal title="Themes" onClose={props.onClose}>
        <div className="muted">Loading…</div>
      </Modal>
    );
  }

  function update<K extends keyof Theme>(k: K, v: Theme[K]): void {
    setT((prev) => (prev ? { ...prev, [k]: v } : prev));
  }

  async function save(): Promise<void> {
    if (!t) return;
    setBusy(true);
    setErr('');
    try {
      await window.buzz.setPrefs({ theme: t });
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    // Roll back the live preview by re-reading saved prefs.
    try {
      const p = await window.buzz.getPrefs();
      applyThemeAttributes(p.theme);
    } catch {
      // ignore
    }
    props.onClose();
  }

  return (
    <Modal title="Themes" onClose={cancel} width={380}>
      <div className="label">Window theme</div>
      <div className="row" style={{ gap: 8 }}>
        <label>
          <input
            type="radio"
            name="wt"
            checked={t.windowTheme === 'classic'}
            onChange={() => update('windowTheme', 'classic')}
          />{' '}
          Classic
        </label>
        <label>
          <input
            type="radio"
            name="wt"
            checked={t.windowTheme === 'aqua'}
            onChange={() => update('windowTheme', 'aqua')}
          />{' '}
          Aqua
        </label>
        <label>
          <input
            type="radio"
            name="wt"
            checked={t.windowTheme === 'graphite'}
            onChange={() => update('windowTheme', 'graphite')}
          />{' '}
          Graphite
        </label>
      </div>

      <div className="label" style={{ marginTop: 6 }}>
        Chat style
      </div>
      <div className="row" style={{ gap: 8 }}>
        <label>
          <input
            type="radio"
            name="ct"
            checked={t.chatTheme === 'classic'}
            onChange={() => update('chatTheme', 'classic')}
          />{' '}
          Classic
        </label>
        <label>
          <input
            type="radio"
            name="ct"
            checked={t.chatTheme === 'balloons'}
            onChange={() => update('chatTheme', 'balloons')}
          />{' '}
          Balloons
        </label>
        <label>
          <input
            type="radio"
            name="ct"
            checked={t.chatTheme === 'compact'}
            onChange={() => update('chatTheme', 'compact')}
          />{' '}
          Compact
        </label>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <div style={{ flex: 1 }}>
          <div className="label">My bubble color</div>
          <input
            type="color"
            value={t.myBubbleColor}
            onChange={(e) => update('myBubbleColor', e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div className="label">Their bubble color</div>
          <input
            type="color"
            value={t.theirBubbleColor}
            onChange={(e) => update('theirBubbleColor', e.target.value)}
          />
        </div>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <label>
          <input
            type="checkbox"
            checked={t.showTimestamps}
            onChange={(e) => update('showTimestamps', e.target.checked)}
          />{' '}
          Show timestamps
        </label>
        <label>
          <input
            type="checkbox"
            checked={t.showAvatarsInChat}
            onChange={(e) => update('showAvatarsInChat', e.target.checked)}
          />{' '}
          Show avatars in chat
        </label>
      </div>

      {/* Mini preview pane mirroring the chosen chat theme. */}
      <div className="label" style={{ marginTop: 6 }}>
        Preview
      </div>
      <div className="bevel-in" style={{ height: 96, overflow: 'hidden' }}>
        <div
          className="chat-log"
          style={{ height: '100%' }}
          data-chat-theme-preview={t.chatTheme}
        >
          {t.chatTheme === 'balloons' ? (
            <>
              <div className="bubble-row in">
                <div className="bubble-avatar" />
                <div className="bubble" style={{ background: t.theirBubbleColor }}>
                  Hey there!
                </div>
              </div>
              <div className="bubble-row out">
                <div className="bubble-avatar" />
                <div className="bubble" style={{ background: t.myBubbleColor }}>
                  Hi — long time no talk.
                </div>
              </div>
            </>
          ) : t.chatTheme === 'compact' ? (
            <>
              <div style={{ fontSize: 11 }}>
                <b style={{ color: '#0000b0' }}>buddy:</b> Hey there!
              </div>
              <div style={{ fontSize: 11 }}>
                <b style={{ color: '#b00000' }}>you:</b> Hi — long time no talk.
              </div>
            </>
          ) : (
            <>
              <div>
                <span className="them">buddy:</span> Hey there!
              </div>
              <div>
                <span className="me">you:</span> Hi — long time no talk.
              </div>
            </>
          )}
        </div>
      </div>

      {err && <div className="error">{err}</div>}
      <div className="actions">
        <button onClick={() => void save()} disabled={busy}>
          Save
        </button>
        <button onClick={() => void cancel()} disabled={busy}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function Modal(props: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}): JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.25)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div className="bevel-out" style={{ width: props.width ?? 320, padding: 0 }}>
        <div className="titlebar">
          <span>{props.title}</span>
          <span style={{ flex: 1 }} />
          <button onClick={props.onClose}>×</button>
        </div>
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {props.children}
        </div>
      </div>
    </div>
  );
}
