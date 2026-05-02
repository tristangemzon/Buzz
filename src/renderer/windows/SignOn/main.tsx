import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformTheme } from '../../theme/applyPlatform';
import { WindowChrome } from '../../components/WindowChrome';
import { SignOnSettings } from '../../components/SignOnSettings';
import buzzLogo from '../../assets/buzz-logo.png';
import type { ProfileSummary } from '@shared/schemas';
import type { ServerUser } from '@shared/schemas';

// ── Local sign-on (P2P / exp-p2p modes) ──────────────────────────────────────

type LocalMode = 'signin' | 'create' | 'migrate';

function LocalSignOn({ onModeChange }: { onModeChange: () => void }): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [isMesh, setIsMesh] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [mode, setMode] = useState<LocalMode>('signin');
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
        const filtered = list.filter((p) => (p.mesh ?? false) === mesh && !p.serverUrl);
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
                  {isMesh ? `${p.screenName} (EM)` : p.screenName}
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
            onClose={() => {
              setShowSettings(false);
              onModeChange();
            }}
            onReset={() => {
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

// ── Server sign-on (Hive server mode) ────────────────────────────────────────

type ServerStep =
  | 'url'       // enter / confirm server URL
  | 'signin'    // account (dropdown or text) + password in one step
  | 'register'; // screen name + password + confirm

function ServerSignOn({ onModeChange, initialUrl }: { onModeChange: () => void; initialUrl: string | null }): JSX.Element {
  const [appVersion, setAppVersion] = useState('');
  const [step, setStep] = useState<ServerStep>('url');
  const [serverUrl, setServerUrl] = useState('');
  const [serverName, setServerName] = useState('');
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<ServerUser | null>(null);
  const [screenName, setScreenName] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [signinScreenName, setSigninScreenName] = useState('');
  const [signinOther, setSigninOther] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  async function tryAutoConnect(url: string): Promise<void> {
    setBusy(true);
    setErr('');
    try {
      const result = await window.buzz.serverDiscover(url);
      setServerName(result.serverName);
      setUsers(result.users);
      setSelectedUser(result.users.length > 0 ? result.users[0]! : null);
      setSigninOther(false);
      setStep('signin');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reach server.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void applyPlatformTheme(window.buzz);
    void window.buzz.getAppVersion().then(setAppVersion);
    if (initialUrl) {
      setServerUrl(initialUrl);
      void tryAutoConnect(initialUrl);
    } else {
      window.buzz.getNetworkConfig().then((cfg) => {
        if (cfg.serverUrl) {
          const url = cfg.serverUrl.trim();
          setServerUrl(url);
          void tryAutoConnect(url);
        }
      });
    }
  }, []);

  async function connect(): Promise<void> {
    setErr('');
    const url = serverUrl.trim();
    if (!url) return setErr('Enter a server URL.');
    if (!/^wss?:\/\/.+/.test(url)) return setErr('URL must start with wss:// or ws://');
    await tryAutoConnect(url);
  }

  async function signIn(): Promise<void> {
    setErr('');
    const name = selectedUser?.screenName ?? signinScreenName.trim();
    if (!name) return setErr('Enter your screen name.');
    if (pass.length < 8) return setErr('Passphrase must be at least 8 characters.');
    setBusy(true);
    try {
      await window.buzz.serverUnlockAccount({
        serverUrl: serverUrl.trim(),
        screenName: name,
        passphrase: pass,
      });
      await window.buzzWindows.openBuddyList();
      window.close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  async function register(): Promise<void> {
    setErr('');
    if (!screenName.trim()) return setErr('Choose a screen name.');
    if (pass.length < 8) return setErr('Passphrase must be at least 8 characters.');
    if (pass !== pass2) return setErr('Passphrases do not match.');
    setBusy(true);
    try {
      await window.buzz.serverRegister({
        serverUrl: serverUrl.trim(),
        screenName: screenName.trim(),
        passphrase: pass,
      });
      await window.buzzWindows.openBuddyList();
      window.close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="window">
      <WindowChrome title="Sign On" canMaximize={false} />
      <div className="signon">
        <div className="signon-banner">
          <img src={buzzLogo} alt="Buzz" />
        </div>

        {/* Step 1: Server URL */}
        {step === 'url' && (
          <>
            <div className="signon-row">
              <label className="signon-label">Server</label>
              <input
                ref={urlRef}
                className="signon-field"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="wss://hostname:7700"
                onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }}
                autoFocus
              />
            </div>
            <div className="error">{err}</div>
            <div className="signon-actionbar">
              <button className="signon-iconbtn" onClick={() => setShowSettings(true)}>
                <span className="signon-iconbtn-glyph">⚙</span>
                <span className="signon-iconbtn-label">Setup</span>
              </button>
              <span className="signon-actionbar-spacer" />
              <button
                className="signon-iconbtn signon-iconbtn-primary"
                onClick={connect}
                disabled={busy}
              >
                <span className="signon-iconbtn-glyph">🐝</span>
                <span className="signon-iconbtn-label">{busy ? 'Connecting…' : 'Connect'}</span>
              </button>
            </div>
          </>
        )}

        {/* Step 2: Sign in — account picker + password in one screen */}
        {step === 'signin' && (
          <>
            <div className="signon-row">
              <span className="signon-label" />
              <span className="signon-hint" style={{ fontWeight: 600 }}>{serverName}</span>
            </div>
            <div className="signon-row">
              <label className="signon-label">Screen Name</label>
              {users.length > 0 && !signinOther ? (
                <select
                  className="signon-field"
                  value={selectedUser?.screenName ?? ''}
                  onChange={(e) => {
                    if (e.target.value === '__other__') {
                      setSigninOther(true);
                      setSelectedUser(null);
                      setSigninScreenName('');
                    } else {
                      const u = users.find((x) => x.screenName === e.target.value) ?? null;
                      setSelectedUser(u);
                    }
                  }}
                >
                  {users.map((u) => (
                    <option key={u.peerId} value={u.screenName}>{u.screenName}</option>
                  ))}
                  <option value="__other__">Existing User?</option>
                </select>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                  <input
                    className="signon-field"
                    value={signinScreenName}
                    onChange={(e) => setSigninScreenName(e.target.value)}
                    placeholder="Screen name"
                    autoFocus
                  />
                  {users.length > 0 && (
                    <button
                      type="button"
                      style={{ alignSelf: 'flex-start', fontSize: '0.8em', marginTop: 2, background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', opacity: 0.7 }}
                      onClick={() => { setSigninOther(false); setSelectedUser(users[0]!); setSigninScreenName(''); }}
                    >
                      ← pick from saved
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="signon-row">
              <label className="signon-label">Password</label>
              <input
                type="password"
                className="signon-field"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void signIn(); }}
                autoFocus={users.length > 0 && !signinOther}
              />
            </div>
            <div className="error">{err}</div>
            <div className="signon-actionbar">
              <button className="signon-iconbtn" onClick={() => setShowSettings(true)}>
                <span className="signon-iconbtn-glyph">⚙</span>
                <span className="signon-iconbtn-label">Setup</span>
              </button>
              <button
                className="signon-iconbtn"
                onClick={() => { setErr(''); setScreenName(''); setPass(''); setPass2(''); setStep('register'); }}
              >
                <span className="signon-iconbtn-glyph">＋</span>
                <span className="signon-iconbtn-label">Register</span>
              </button>
              <span className="signon-actionbar-spacer" />
              <button
                className="signon-iconbtn signon-iconbtn-primary"
                onClick={signIn}
                disabled={busy}
              >
                <span className="signon-iconbtn-glyph">🐝</span>
                <span className="signon-iconbtn-label">{busy ? 'Signing in…' : 'Sign On'}</span>
              </button>
            </div>
          </>
        )}

        {/* Step 3: Register new account */}
        {step === 'register' && (
          <>
            <div className="signon-row">
              <span className="signon-label" />
              <span className="signon-hint" style={{ fontWeight: 600 }}>{serverName}</span>
            </div>
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
            <div className="signon-row">
              <label className="signon-label">Password</label>
              <input
                type="password"
                className="signon-field"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </div>
            <div className="signon-row">
              <label className="signon-label">Confirm</label>
              <input
                type="password"
                className="signon-field"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void register(); }}
              />
            </div>
            <div className="error">{err}</div>
            <div className="signon-actionbar">
              <button className="signon-iconbtn" onClick={() => setShowSettings(true)}>
                <span className="signon-iconbtn-glyph">⚙</span>
                <span className="signon-iconbtn-label">Setup</span>
              </button>
              <button
                className="signon-iconbtn"
                onClick={() => { setErr(''); setSigninScreenName(''); setPass(''); setStep('signin'); }}
              >
                <span className="signon-iconbtn-glyph">🐝</span>
                <span className="signon-iconbtn-label">Sign On</span>
              </button>
              <span className="signon-actionbar-spacer" />
              <button
                className="signon-iconbtn signon-iconbtn-primary"
                onClick={register}
                disabled={busy}
              >
                <span className="signon-iconbtn-glyph">＋</span>
                <span className="signon-iconbtn-label">{busy ? 'Registering…' : 'Register'}</span>
              </button>
            </div>
          </>
        )}

        <div className="signon-version">Version: {appVersion}</div>

        {showSettings && (
          <SignOnSettings
            onClose={() => {
              setShowSettings(false);
              onModeChange();
              // If a URL was just configured, auto-connect immediately.
              window.buzz.getNetworkConfig().then((cfg) => {
                if (cfg.serverUrl) {
                  const url = cfg.serverUrl.trim();
                  setServerUrl(url);
                  void tryAutoConnect(url);
                }
              });
            }}
            onReset={() => {
              setStep('url');
              setServerUrl('');
              setErr('');
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Root: pick flow based on network mode ─────────────────────────────────────

function App(): JSX.Element {
  const [mode, setMode] = useState<'loading' | 'local' | 'server'>('loading');
  const [autoConnectUrl, setAutoConnectUrl] = useState<string | null>(null);

  function recheckMode(): void {
    window.buzz.getNetworkConfig().then((cfg) => {
      const next = cfg.mode === 'server' ? 'server' : 'local';
      setAutoConnectUrl(cfg.mode === 'server' && cfg.serverUrl ? cfg.serverUrl.trim() : null);
      setMode(next);
    });
  }

  useEffect(() => {
    recheckMode();
  }, []);

  if (mode === 'loading') {
    return (
      <div className="window">
        <WindowChrome title="Sign On" canMaximize={false} />
        <div className="signon">Loading…</div>
      </div>
    );
  }

  return mode === 'server'
    ? <ServerSignOn onModeChange={recheckMode} initialUrl={autoConnectUrl} />
    : <LocalSignOn onModeChange={recheckMode} />;
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
