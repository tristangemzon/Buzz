import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { SignOnSettings } from '../../components/SignOnSettings';
import buzzLogo from '../../assets/buzz-logo.png';
import type { ProfileSummary } from '@shared/schemas';

type Mode = 'signin' | 'create' | 'migrate';

function App(): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [, setIsMesh] = useState(false);
  const [appVersion, setAppVersion] = useState('');
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
    void window.buzz.getAppVersion().then(setAppVersion);
    Promise.all([window.buzz.listProfiles(), window.buzz.getNetworkConfig()]).then(
      ([list, netCfg]) => {
        const mesh = netCfg.mode === 'exp-p2p';
        setIsMesh(mesh);
        // Show all local (non-server) profiles regardless of which local mode
        // (p2p vs exp-p2p) they were created in — the same keystore works for both.
        // Server profiles are handled exclusively by ServerSignOn.
        const filtered = list.filter((p) => !p.serverUrl);
        setProfiles(filtered);
        if (filtered.length === 0) {
          setMode('create');
        } else {
          setMode('signin');
          setSelectedId(filtered[0]!.id);
        }
      },
    );
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
      } else if (mode === 'migrate') {
        await window.buzz.migrateDb({ profileId: selectedId, passphrase: pass });
        await window.buzz.unlock({ profileId: selectedId, passphrase: pass });
      } else {
        try {
          await window.buzz.unlock({ profileId: selectedId, passphrase: pass });
        } catch (e) {
          const code = (e as { code?: string }).code ?? (e instanceof Error ? e.message : '');
          if (code === 'LEGACY_DB' || code.includes('LEGACY_DB')) {
            // Old database format — switch to migrate mode and let the user confirm.
            setMode('migrate');
            setErr('Your data is from an older version. Click Migrate to convert it.');
            return;
          }
          throw e;
        }
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
        <div className="signon-banner">
          <img src={buzzLogo} alt="Buzz" />
        </div>

        {mode === 'migrate' && (
          <div className="signon-row">
            <span className="signon-label" />
            <span className="signon-hint">
              Select your account and enter your password to migrate your data to the new format.
            </span>
          </div>
        )}

        {(mode === 'signin' || mode === 'migrate') && (
          <div className="signon-row">
            <label className="signon-label">Screen Name</label>
            <select
              className="signon-field"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              autoFocus
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.mesh ? `${p.screenName} (EM)` : p.screenName}
                </option>
              ))}
            </select>
          </div>
        )}

        {mode === 'create' && (
          <div className="signon-row">
            <label className="signon-label">Screen Name</label>
            <input
              className="signon-field"
              value={screenName}
              onChange={(e) => setScreenName(e.target.value)}
              maxLength={32}
              autoFocus
            />
          </div>
        )}

        <div className="signon-row">
          <label className="signon-label">Password</label>
          <input
            type="password"
            className="signon-field"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoFocus={mode === 'signin'}
          />
        </div>

        {mode === 'create' && (
          <div className="signon-row">
            <label className="signon-label">Confirm</label>
            <input
              type="password"
              className="signon-field"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
            />
          </div>
        )}

        <div className="error">{err}</div>

        <div className="signon-actionbar">
          <button
            className="signon-iconbtn"
            title="Settings"
            aria-label="Settings"
            onClick={() => setShowSettings(true)}
          >
            <span className="signon-iconbtn-glyph">⚙</span>
            <span className="signon-iconbtn-label">Setup</span>
          </button>
          {hasProfiles && mode === 'signin' && (
            <button
              className="signon-iconbtn"
              onClick={() => {
                setErr('Your data is from an older version. Enter your password and click Migrate.');
                setMode('migrate');
              }}
              disabled={busy}
              title="Migrate data from an older version"
            >
              <span className="signon-iconbtn-glyph">⬆</span>
              <span className="signon-iconbtn-label">Migrate</span>
            </button>
          )}
          {hasProfiles && mode !== 'migrate' && (
            <button
              className="signon-iconbtn"
              onClick={() => {
                setErr('');
                setPass('');
                setPass2('');
                setScreenName('');
                setMode((m) => (m === 'create' ? 'signin' : 'create'));
              }}
              disabled={busy}
              title={mode === 'create' ? 'Sign on instead' : 'New screen name'}
            >
              <span className="signon-iconbtn-glyph">{mode === 'create' ? '↩' : '＋'}</span>
              <span className="signon-iconbtn-label">
                {mode === 'create' ? 'Sign On' : 'New User'}
              </span>
            </button>
          )}
          {mode === 'migrate' && (
            <button
              className="signon-iconbtn"
              onClick={() => {
                setErr('');
                setMode('signin');
              }}
              disabled={busy}
              title="Back to sign in"
            >
              <span className="signon-iconbtn-glyph">↩</span>
              <span className="signon-iconbtn-label">Cancel</span>
            </button>
          )}
          <span className="signon-actionbar-spacer" />
          <button
            className="signon-iconbtn signon-iconbtn-primary"
            onClick={submit}
            disabled={busy}
            title={mode === 'create' ? 'Create account' : mode === 'migrate' ? 'Migrate data' : 'Sign On'}
          >
            <span className="signon-iconbtn-glyph">🐝</span>
            <span className="signon-iconbtn-label">
              {mode === 'create' ? 'Create' : mode === 'migrate' ? 'Migrate' : 'Sign On'}
            </span>
          </button>
        </div>

        <div className="signon-version">Version: {appVersion}</div>

        {showSettings && (
          <SignOnSettings
            onClose={() => setShowSettings(false)}
            onReset={() => {
              // After a factory reset, profiles are gone — re-fetch and snap
              // back to the create-account flow.
              setSelectedId('');
              setScreenName('');
              setPass('');
              setPass2('');
              setErr('');
              window.buzz.listProfiles().then((list) => {
                setProfiles(list);
                setMode('create');
              });
            }}
          />
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
