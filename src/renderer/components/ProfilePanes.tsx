// "Edit My Profile" form. Shared between any window that wants to surface it,
// but BuddyList is the primary host today. All persistence happens through
// the typed IPC bridge — this component is a thin form.

import React, { useEffect, useRef, useState } from 'react';
import type { Profile } from '@shared/schemas';
import { FormatToolbar, RichText, handleFormatShortcut } from './RichText';

const AVATAR_MAX_BYTES = 64 * 1024;
const BG_MAX_BYTES = 128 * 1024;

async function readFileAsDataUrl(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes * 1.5) {
    throw new Error(
      `File too large (${Math.ceil(file.size / 1024)} KB). Pick something under ${Math.floor(
        maxBytes / 1024,
      )} KB.`,
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Read failed'));
    reader.onload = () => {
      const url = reader.result;
      if (typeof url !== 'string') return reject(new Error('Read failed'));
      // Encoded base64 grows ~33%; reject if the encoded string blows the cap.
      const approxBytes = url.length;
      if (approxBytes > maxBytes * 1.4) {
        reject(
          new Error(
            `Encoded image too large; pick a smaller image (under ~${Math.floor(maxBytes / 1024)} KB).`,
          ),
        );
        return;
      }
      resolve(url);
    };
    reader.readAsDataURL(file);
  });
}

export function ProfileEditor(props: { onClose: () => void }): JSX.Element {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const aboutRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void window.buzz.getMyProfile().then(setP);
  }, []);

  if (!p) {
    return (
      <Modal title="My Profile" onClose={props.onClose}>
        <div className="muted">Loading…</div>
      </Modal>
    );
  }

  function update<K extends keyof Profile>(k: K, v: Profile[K]): void {
    setP((prev) => (prev ? { ...prev, [k]: v } : prev));
  }

  async function pickAvatar(file: File | undefined): Promise<void> {
    if (!file) return;
    setErr('');
    try {
      const url = await readFileAsDataUrl(file, AVATAR_MAX_BYTES);
      update('avatarDataUrl', url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read image.');
    }
  }

  async function pickBg(file: File | undefined): Promise<void> {
    if (!file) return;
    setErr('');
    try {
      const url = await readFileAsDataUrl(file, BG_MAX_BYTES);
      update('bgImageDataUrl', url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read image.');
    }
  }

  async function save(): Promise<void> {
    if (!p) return;
    setBusy(true);
    setErr('');
    try {
      await window.buzz.setMyProfile(p);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  // Live preview pane — what buddies will see.
  const previewStyle: React.CSSProperties = {
    color: p.textColor || '#000',
    background: p.bgColor || '#fff',
    fontFamily: p.fontFamily || undefined,
    backgroundImage: p.bgImageDataUrl ? `url(${p.bgImageDataUrl})` : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    padding: 8,
    minHeight: 64,
    border: '1px solid #888',
    overflow: 'auto',
    maxHeight: 120,
  };

  return (
    <Modal title="My Profile" onClose={props.onClose} width={420}>
      {/* Avatar + stock pics row */}
      <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        {/* Current avatar preview */}
        <div style={{ flexShrink: 0 }}>
          {p.avatarDataUrl ? (
            <img
              src={p.avatarDataUrl}
              alt="avatar"
              style={{ width: 72, height: 72, objectFit: 'cover', border: '1px solid #888', display: 'block' }}
            />
          ) : (
            <div
              style={{
                width: 72, height: 72, background: '#ddd', border: '1px solid #888',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, color: '#666',
              }}
            >
              no pic
            </div>
          )}
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* Hidden real file input, triggered by styled label */}
            <label style={{ display: 'block' }}>
              <span
                style={{
                  display: 'block', textAlign: 'center', padding: '2px 4px',
                  fontSize: 10, cursor: 'pointer',
                  background: '#d4d0c8', border: '1px solid',
                  borderTopColor: '#fff', borderLeftColor: '#fff',
                  borderBottomColor: '#808080', borderRightColor: '#808080',
                }}
              >
                Choose File…
              </span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => void pickAvatar(e.target.files?.[0])}
                style={{ display: 'none' }}
              />
            </label>
            {p.avatarDataUrl && (
              <button
                onClick={() => update('avatarDataUrl', '')}
                style={{ fontSize: 10, padding: '2px 4px' }}
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {/* Stock default profile pics */}
        <div style={{ flex: 1 }}>
          <div className="label" style={{ marginBottom: 4 }}>Default pics</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {['20001','20003','20004','20006','2000a','2000b','2000c'].map((name) => {
              const url = `defaultpics/${name}.png`;
              async function pickStock(): Promise<void> {
                setErr('');
                try {
                  const resp = await fetch(url);
                  if (!resp.ok) throw new Error('Failed to load image.');
                  const blob = await resp.blob();
                  const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onerror = () => reject(new Error('Read failed'));
                    reader.onload = () => resolve(reader.result as string);
                    reader.readAsDataURL(blob);
                  });
                  update('avatarDataUrl', dataUrl);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : 'Could not load image.');
                }
              }
              return (
                <img
                  key={name}
                  src={url}
                  alt={name}
                  onClick={() => void pickStock()}
                  style={{
                    width: 40, height: 40, objectFit: 'cover', cursor: 'pointer',
                    border: '1px solid #888',
                    boxSizing: 'border-box',
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="label">About me</div>
          <FormatToolbar
            textareaRef={aboutRef}
            value={p.aboutText}
            onChange={(v) => update('aboutText', v.slice(0, 2000))}
          />
          <textarea
            ref={aboutRef}
            className="bevel-in"
            rows={4}
            value={p.aboutText}
            onChange={(e) => update('aboutText', e.target.value.slice(0, 2000))}
            onKeyDown={(e) =>
              handleFormatShortcut(e, aboutRef, p.aboutText, (v) =>
                update('aboutText', v.slice(0, 2000)),
              )
            }
            style={{ width: '100%', resize: 'vertical' }}
            placeholder="Tell your buddies about yourself…"
          />
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div className="label">Text color</div>
          <input
            type="color"
            value={p.textColor || '#000000'}
            onChange={(e) => update('textColor', e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <div className="label">Background color</div>
          <input
            type="color"
            value={p.bgColor || '#ffffff'}
            onChange={(e) => update('bgColor', e.target.value)}
          />
        </div>
      </div>

      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="label">Font</div>
          <select
            value={p.fontFamily}
            onChange={(e) => update('fontFamily', e.target.value)}
            style={{ width: '100%' }}
          >
            <option value="">(default)</option>
            <option value="Times New Roman, serif">Times New Roman</option>
            <option value="Georgia, serif">Georgia</option>
            <option value="Tahoma, sans-serif">Tahoma</option>
            <option value="Verdana, sans-serif">Verdana</option>
            <option value="Comic Sans MS, cursive">Comic Sans MS</option>
            <option value="Courier New, monospace">Courier New</option>
            <option value="Impact, sans-serif">Impact</option>
            <option value="Lucida Grande, sans-serif">Lucida Grande</option>
          </select>
        </div>
      </div>

      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="label">Background image</div>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => void pickBg(e.target.files?.[0])}
          />
          {p.bgImageDataUrl && (
            <button onClick={() => update('bgImageDataUrl', '')} style={{ marginLeft: 8 }}>
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="label" style={{ marginTop: 4 }}>
        Preview
      </div>
      <div style={previewStyle}>
        {p.aboutText ? (
          <RichText body={p.aboutText} />
        ) : (
          <span style={{ opacity: 0.5 }}>Your about text appears here…</span>
        )}
      </div>

      {err && <div className="error">{err}</div>}
      <div className="actions">
        <button onClick={() => void save()} disabled={busy}>
          Save
        </button>
        <button onClick={props.onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

// View-only profile pane for a buddy. Styled with the buddy's chosen colors,
// font, and background image.
export function ProfileViewer(props: {
  peerId: string;
  alias: string;
  onClose: () => void;
}): JSX.Element {
  const [p, setP] = useState<{
    aboutText: string;
    textColor: string;
    bgColor: string;
    fontFamily: string;
    avatarDataUrl: string;
    bgImageDataUrl: string;
    screenName: string;
  } | null>(null);

  useEffect(() => {
    void window.buzz.getPeerProfile(props.peerId).then((row) => {
      if (row) setP(row);
      else
        setP({
          aboutText: '',
          textColor: '',
          bgColor: '',
          fontFamily: '',
          avatarDataUrl: '',
          bgImageDataUrl: '',
          screenName: props.alias,
        });
    });
  }, [props.peerId]);

  const style: React.CSSProperties = {
    color: p?.textColor || '#000',
    background: p?.bgColor || '#fff',
    fontFamily: p?.fontFamily || undefined,
    backgroundImage: p?.bgImageDataUrl ? `url(${p.bgImageDataUrl})` : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    padding: 12,
    minHeight: 120,
    border: '1px solid #888',
    overflow: 'auto',
    maxHeight: 320,
    whiteSpace: 'pre-wrap',
  };

  return (
    <Modal title={`Profile — ${props.alias}`} onClose={props.onClose} width={420}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {p?.avatarDataUrl && (
          <img
            src={p.avatarDataUrl}
            alt="avatar"
            style={{ width: 64, height: 64, objectFit: 'cover', border: '1px solid #888' }}
          />
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 'bold' }}>{p?.screenName || props.alias}</div>
          <div className="muted" style={{ fontSize: 10, wordBreak: 'break-all' }}>
            {props.peerId}
          </div>
        </div>
      </div>
      <div style={style}>
        {p?.aboutText ? (
          <RichText body={p.aboutText} />
        ) : (
          <span style={{ opacity: 0.5 }}>This buddy hasn't shared a profile yet.</span>
        )}
      </div>
      <div className="actions">
        <button onClick={props.onClose}>Close</button>
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
