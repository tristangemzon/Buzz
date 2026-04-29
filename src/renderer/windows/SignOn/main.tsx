import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { NetworkSettings } from '../../components/NetworkSettings';
import type { ProfileSummary } from '@shared/schemas';

type Mode = 'signin' | 'create';

function App(): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [selectedId, setSelectedId] = useState<string>('');
  const [screenName, setScreenName] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    void applyPlatformTheme(window.buzz);
    window.buzz.listProfiles().then((list) => {
      setProfiles(list);
      if (list.length === 0) {
        setMode('create');
      } else {
        setMode('signin');
        setSelectedId(list[0]!.id);
      }
    });
  }, []);

  async function submit(): Promise<void> {
    setErr('');
    if (pass.length < 8) return setErr('Passphrase must be at least 8 characters.');
    if (mode === 'create') {
      if (!screenName.trim()) return setErr('Choose a screen name.');
      if (pass !== pass2) return setErr('Passphrases do not match.');
    } else {
      if (!selectedId) return setErr('Pick an account.');
    }
    setBusy(true);
    try {
      if (mode === 'create') {
        await window.buzz.createIdentity({ screenName: screenName.trim(), passphrase: pass });
      } else {
        await window.buzz.unlock({ profileId: selectedId, passphrase: pass });
      }
      await window.buzzWindows.openBuddyList();
      window.close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }

  if (profiles === null)
    return (
      <div className="window">
        <WindowChrome title="Sign On" canMaximize={false} />
        <div className="signon">Loading…</div>
      </div>
    );

  const hasProfiles = profiles.length > 0;

  return (
    <div className="window">
      <WindowChrome title="Sign On" canMaximize={false} />
      <div className="signon">
        <div className="runner-big" title="Welcome" />
        <h1>Welcome</h1>
        <div className="muted">
          {mode === 'create'
            ? hasProfiles
              ? 'Create a new screen name'
              : 'Create your screen name'
            : 'Sign on to your screen name'}
        </div>

        {mode === 'signin' && (
          <div className="row">
            <label className="label">Screen Name</label>
            <select
              className="bevel-in"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              autoFocus
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.screenName}
                </option>
              ))}
            </select>
          </div>
        )}

        {mode === 'create' && (
          <div className="row">
            <label className="label">Screen Name</label>
            <input
              className="bevel-in"
              value={screenName}
              onChange={(e) => setScreenName(e.target.value)}
              maxLength={32}
              autoFocus
            />
          </div>
        )}

        <div className="row">
          <label className="label">Passphrase</label>
          <input
            type="password"
            className="bevel-in"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoFocus={mode === 'signin'}
          />
        </div>

        {mode === 'create' && (
          <div className="row">
            <label className="label">Confirm passphrase</label>
            <input
              type="password"
              className="bevel-in"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
            />
          </div>
        )}

        <div className="error">{err}</div>

        <div className="actions">
          <button onClick={submit} disabled={busy}>
            {mode === 'create' ? 'Create' : 'Sign On'}
          </button>
          {hasProfiles && (
            <button
              onClick={() => {
                setErr('');
                setPass('');
                setPass2('');
                setScreenName('');
                setMode((m) => (m === 'create' ? 'signin' : 'create'));
              }}
              disabled={busy}
            >
              {mode === 'create' ? 'Sign On Instead' : 'New Screen Name'}
            </button>
          )}
        </div>
        <button
          className="signon-cog"
          title="Network settings"
          aria-label="Network settings"
          onClick={() => setShowSettings(true)}
        >
          ⚙
        </button>
        {showSettings && <NetworkSettings onClose={() => setShowSettings(false)} />}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
