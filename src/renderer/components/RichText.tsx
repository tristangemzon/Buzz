// Tiny safe-subset HTML renderer + textarea formatting toolbar used by both
// the 1:1 IM window and the chat-room window. The "rich text" supported on
// the wire is a deliberately small set of HTML-ish tags so the body remains
// a normal plain-string IM and old clients still see something readable.
//
// Allowed tags: <b>, <i>, <u>, <mark>, <small>, <big>, <a href="...">.
// Anything else is rendered as escaped text.

import React, { useEffect, useRef, useState } from 'react';

type Token =
  | { t: 'text'; v: string }
  | { t: 'tag'; tag: string; href?: string; close: boolean };

const ALLOWED_TAGS = new Set(['b', 'i', 'u', 'mark', 'small', 'big', 'a']);
const URL_RE = /^(https?:|mailto:)/i;
const TAG_RE = /<\s*(\/?)\s*([a-zA-Z]+)(\s+href\s*=\s*"([^"<>]*)")?\s*\/?\s*>/g;

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const m of input.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ t: 'text', v: input.slice(last, idx) });
    const close = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    const href = m[4];
    if (ALLOWED_TAGS.has(tag)) {
      out.push({ t: 'tag', tag, href, close });
    } else {
      out.push({ t: 'text', v: m[0] });
    }
    last = idx + m[0].length;
  }
  if (last < input.length) out.push({ t: 'text', v: input.slice(last) });
  return out;
}

// Render the safe-subset of rich text. Unmatched / disallowed tags fall back
// to literal text so we never inject raw HTML.
export function RichText({ body }: { body: string }): JSX.Element {
  const tokens = tokenize(body);
  const stack: Array<{ tag: string; href?: string; children: React.ReactNode[] }> = [
    { tag: '__root__', children: [] },
  ];
  let key = 0;
  for (const tk of tokens) {
    const top = stack[stack.length - 1]!;
    if (tk.t === 'text') {
      top.children.push(tk.v);
      continue;
    }
    if (tk.close) {
      // Close down to the most-recent matching open tag; if no match, treat
      // as literal text so we don't drop content.
      const matchIdx = (() => {
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i]!.tag === tk.tag) return i;
        }
        return -1;
      })();
      if (matchIdx === -1) {
        top.children.push(`</${tk.tag}>`);
        continue;
      }
      while (stack.length - 1 >= matchIdx) {
        const frame = stack.pop()!;
        const parent = stack[stack.length - 1]!;
        parent.children.push(renderTag(frame.tag, frame.href, frame.children, key++));
      }
    } else {
      stack.push({ tag: tk.tag, href: tk.href, children: [] });
    }
  }
  // Auto-close any unclosed tags by collapsing them up.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    const parent = stack[stack.length - 1]!;
    parent.children.push(renderTag(frame.tag, frame.href, frame.children, key++));
  }
  return <>{stack[0]!.children}</>;
}

function renderTag(
  tag: string,
  href: string | undefined,
  children: React.ReactNode[],
  k: number,
): JSX.Element {
  switch (tag) {
    case 'b':
      return <b key={k}>{children}</b>;
    case 'i':
      return <i key={k}>{children}</i>;
    case 'u':
      return <u key={k}>{children}</u>;
    case 'mark':
      return <mark key={k}>{children}</mark>;
    case 'small':
      return <small key={k}>{children}</small>;
    case 'big':
      return (
        <span key={k} style={{ fontSize: '1.25em' }}>
          {children}
        </span>
      );
    case 'a':
      if (href && URL_RE.test(href)) {
        return (
          <a key={k} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        );
      }
      // Disallowed URL scheme — render the inner text only.
      return <span key={k}>{children}</span>;
    default:
      return <span key={k}>{children}</span>;
  }
}

// ── Toolbar ───────────────────────────────────────────────────────────────

type Wrap = { open: string; close: string };
const WRAPS: Record<string, Wrap> = {
  bold: { open: '<b>', close: '</b>' },
  italic: { open: '<i>', close: '</i>' },
  underline: { open: '<u>', close: '</u>' },
  highlight: { open: '<mark>', close: '</mark>' },
  small: { open: '<small>', close: '</small>' },
  big: { open: '<big>', close: '</big>' },
};

const EMOJI = [
  '🙂', '😀', '😄', '😆', '😉', '😍', '😎', '😘',
  '😢', '😭', '😡', '😱', '🤔', '😴', '👍', '👎',
  '❤️', '💔', '🎉', '🔥', '✨', '☕', '🍺', '🌧️',
  '⭐', '🚀', '👀', '🙏', '💯', '😂', '😜', '🤷',
];

export type FormatToolbarProps = {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange(next: string): void;
  disabled?: boolean;
};

export function FormatToolbar(props: FormatToolbarProps): JSX.Element {
  const { textareaRef, value, onChange, disabled } = props;
  const [showEmoji, setShowEmoji] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);

  function applyWrap(kind: keyof typeof WRAPS): void {
    const ta = textareaRef.current;
    if (!ta) return;
    const { open, close } = WRAPS[kind]!;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const before = value.slice(0, start);
    const sel = value.slice(start, end);
    const after = value.slice(end);
    const next = `${before}${open}${sel}${close}${after}`;
    onChange(next);
    // Restore cursor inside the inserted markers.
    requestAnimationFrame(() => {
      const ta2 = textareaRef.current;
      if (!ta2) return;
      ta2.focus();
      const caret = sel
        ? start + open.length + sel.length + close.length
        : start + open.length;
      ta2.setSelectionRange(caret, caret);
    });
  }

  function insertLink(): void {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const sel = value.slice(start, end);
    const url = window.prompt('Link URL (https://… or mailto:…):', 'https://');
    if (!url) return;
    if (!URL_RE.test(url)) {
      window.alert('Only http(s):// and mailto: links are allowed.');
      return;
    }
    const text = sel || window.prompt('Link text:', url) || url;
    const open = `<a href="${url}">`;
    const close = '</a>';
    const before = value.slice(0, start);
    const after = value.slice(end);
    const next = `${before}${open}${text}${close}${after}`;
    onChange(next);
    requestAnimationFrame(() => {
      const ta2 = textareaRef.current;
      if (!ta2) return;
      ta2.focus();
      const caret = before.length + open.length + text.length + close.length;
      ta2.setSelectionRange(caret, caret);
    });
  }

  function insertEmoji(emoji: string): void {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const before = value.slice(0, start);
    const after = value.slice(end);
    onChange(`${before}${emoji}${after}`);
    setShowEmoji(false);
    requestAnimationFrame(() => {
      const ta2 = textareaRef.current;
      if (!ta2) return;
      ta2.focus();
      const caret = start + emoji.length;
      ta2.setSelectionRange(caret, caret);
    });
  }

  // Close the emoji popover on outside click.
  useEffect(() => {
    if (!showEmoji) return;
    const onDoc = (e: MouseEvent): void => {
      if (emojiBtnRef.current?.contains(e.target as Node)) return;
      setShowEmoji(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showEmoji]);

  return (
    <div className="format-toolbar" aria-disabled={disabled}>
      <button
        type="button"
        className="fmt-btn fmt-bold"
        title="Bold (Ctrl/Cmd+B)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => applyWrap('bold')}
        disabled={disabled}
      >
        B
      </button>
      <button
        type="button"
        className="fmt-btn fmt-italic"
        title="Italic (Ctrl/Cmd+I)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => applyWrap('italic')}
        disabled={disabled}
      >
        I
      </button>
      <button
        type="button"
        className="fmt-btn fmt-underline"
        title="Underline (Ctrl/Cmd+U)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => applyWrap('underline')}
        disabled={disabled}
      >
        U
      </button>
      <button
        type="button"
        className="fmt-btn fmt-highlight"
        title="Highlight"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => applyWrap('highlight')}
        disabled={disabled}
      >
        H
      </button>
      <span className="fmt-sep" />
      <button
        type="button"
        className="fmt-btn fmt-size-sm"
        title="Smaller text"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => applyWrap('small')}
        disabled={disabled}
      >
        A-
      </button>
      <button
        type="button"
        className="fmt-btn fmt-size-md"
        title="Normal size (no formatting)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          // "Normal size" inserts no marker; just refocus the textarea.
          textareaRef.current?.focus();
        }}
        disabled={disabled}
      >
        A
      </button>
      <button
        type="button"
        className="fmt-btn fmt-size-lg"
        title="Bigger text"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => applyWrap('big')}
        disabled={disabled}
      >
        A+
      </button>
      <span className="fmt-sep" />
      <button
        type="button"
        className="fmt-btn fmt-link"
        title="Insert link"
        onMouseDown={(e) => e.preventDefault()}
        onClick={insertLink}
        disabled={disabled}
      >
        🔗
      </button>
      <span className="fmt-emoji-wrap">
        <button
          type="button"
          ref={emojiBtnRef}
          className="fmt-btn fmt-emoji"
          title="Insert emoji"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowEmoji((v) => !v)}
          disabled={disabled}
        >
          😀
        </button>
        {showEmoji && (
          <div className="emoji-pop" role="menu">
            {EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                className="emoji-cell"
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => insertEmoji(e)}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}

// Wire Cmd/Ctrl+B/I/U on the textarea so the keyboard shortcuts feel native.
export function handleFormatShortcut(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  textareaRef: React.RefObject<HTMLTextAreaElement>,
  value: string,
  onChange: (s: string) => void,
): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  const k = e.key.toLowerCase();
  const map: Record<string, keyof typeof WRAPS> = { b: 'bold', i: 'italic', u: 'underline' };
  const which = map[k];
  if (!which) return false;
  e.preventDefault();
  const ta = textareaRef.current;
  if (!ta) return true;
  const { open, close } = WRAPS[which]!;
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  const before = value.slice(0, start);
  const sel = value.slice(start, end);
  const after = value.slice(end);
  onChange(`${before}${open}${sel}${close}${after}`);
  requestAnimationFrame(() => {
    const ta2 = textareaRef.current;
    if (!ta2) return;
    ta2.focus();
    const caret = sel
      ? start + open.length + sel.length + close.length
      : start + open.length;
    ta2.setSelectionRange(caret, caret);
  });
  return true;
}
