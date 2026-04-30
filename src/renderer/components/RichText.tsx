// Tiny safe-subset HTML renderer + WYSIWYG compose editor used by both
// the 1:1 IM window and the chat-room window. The "rich text" supported on
// the wire is a deliberately small set of HTML-ish tags so the body remains
// a normal plain-string IM and old clients still see something readable.
//
// Allowed tags: <b>, <i>, <u>, <mark>, <small>, <big>, <a href="...">.
// Anything else is rendered as escaped text.

import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';

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
  // Ref on the WRAPPER span (not just the button) so the outside-click check
  // covers both the toggle button and the emoji grid — clicking an emoji cell
  // no longer closes the popup before the click handler fires.
  const emojiWrapRef = useRef<HTMLSpanElement>(null);

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
      if (emojiWrapRef.current?.contains(e.target as Node)) return;
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
      <span ref={emojiWrapRef} className="fmt-emoji-wrap">
        <button
          type="button"
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

// ── RichEditor (WYSIWYG contentEditable compose box) ─────────────────────
//
// Replaces the textarea + FormatToolbar combo in the IM and Chat compose
// areas. Formatting buttons apply visual effects directly (bold looks bold,
// highlight looks highlighted) instead of inserting raw tag text.
//
// Wire serialisation: the DOM is walked on every change and converted back to
// the same <b>/<i>/... tag format the server/peers expect, so the rest of the
// codebase is unchanged.

export type RichEditorHandle = {
  /** Serialise current content to our wire tag format. */
  getMarkup(): string;
  /** Clear the editor and fire onMarkupChange('') */
  clear(): void;
  focus(): void;
  /** Open the emoji picker (can be called from a parent action bar). */
  openEmojiPicker(): void;
};

export type RichEditorProps = {
  placeholder?: string;
  disabled?: boolean;
  /** If true, Enter inserts a newline; otherwise Enter fires onEnter(). */
  multiLine?: boolean;
  onMarkupChange?: (markup: string) => void;
  onEnter?: () => void;
  style?: React.CSSProperties;
};

// Escape helpers for building HTML strings inserted via execCommand.
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Serialise a contentEditable element's DOM back to our wire tag format.
function serializeContentEditable(el: HTMLElement | null): string {
  if (!el) return '';
  return serChildren(el).trim();
}

function serChildren(node: Node): string {
  return Array.from(node.childNodes).map(serNode).join('');
}

function serNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const inner = serChildren(el);
  switch (el.tagName) {
    case 'B':
    case 'STRONG':
      return `<b>${inner}</b>`;
    case 'I':
    case 'EM':
      return `<i>${inner}</i>`;
    case 'U':
      return `<u>${inner}</u>`;
    case 'MARK':
      return `<mark>${inner}</mark>`;
    case 'SMALL':
      return `<small>${inner}</small>`;
    case 'BIG':
      return `<big>${inner}</big>`;
    case 'A': {
      const href = el.getAttribute('href') ?? '';
      if (URL_RE.test(href)) return `<a href="${escAttr(href)}">${inner}</a>`;
      return inner;
    }
    case 'BR':
      return '\n';
    case 'DIV':
    case 'P':
      // Chromium wraps each new paragraph in <div> when Enter is pressed.
      return inner + (el.nextSibling ? '\n' : '');
    case 'SPAN': {
      // execCommand may produce <span style="..."> in some Chromium versions.
      const fw = el.style.fontWeight;
      const fs = el.style.fontStyle;
      const td = el.style.textDecoration;
      let r = inner;
      if (td.includes('underline')) r = `<u>${r}</u>`;
      if (fs === 'italic') r = `<i>${r}</i>`;
      if (fw === 'bold' || fw === '700') r = `<b>${r}</b>`;
      return r;
    }
    default:
      return inner;
  }
}

export const RichEditor = React.forwardRef<RichEditorHandle, RichEditorProps>(
  function RichEditor({ placeholder, disabled, multiLine, onMarkupChange, onEnter, style }, ref) {
    const divRef = useRef<HTMLDivElement>(null);
    const [showEmoji, setShowEmoji] = useState(false);
    const emojiWrapRef = useRef<HTMLSpanElement>(null);

    useImperativeHandle(ref, () => ({
      getMarkup: () => serializeContentEditable(divRef.current),
      clear: () => {
        if (divRef.current) divRef.current.innerHTML = '';
        onMarkupChange?.('');
      },
      focus: () => divRef.current?.focus(),
      openEmojiPicker: () => setShowEmoji(true),
    }));

    function notify(): void {
      onMarkupChange?.(serializeContentEditable(divRef.current));
    }

    // Bold/italic/underline use execCommand which handles toggle + selection.
    function execFmt(cmd: string): void {
      divRef.current?.focus();
      document.execCommand(cmd);
      notify();
    }

    // For mark/small/big: wrap the current selection in the given tags.
    function wrapSel(tagOpen: string, tagClose: string): void {
      const el = divRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      const selectedText = range.toString();
      if (!selectedText) return; // nothing selected — do nothing
      document.execCommand('insertHTML', false, `${tagOpen}${escHtml(selectedText)}${tagClose}`);
      notify();
    }

    function insertLink(): void {
      const el = divRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      const selectedText = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).toString() : '';
      const url = window.prompt('Link URL (https://… or mailto:…):', 'https://');
      if (!url) return;
      if (!URL_RE.test(url)) {
        window.alert('Only http(s):// and mailto: links are allowed.');
        return;
      }
      const text = selectedText || window.prompt('Link text:', url) || url;
      document.execCommand('insertHTML', false, `<a href="${escAttr(url)}">${escHtml(text)}</a>`);
      notify();
    }

    function insertEmoji(emoji: string): void {
      const el = divRef.current;
      if (!el) return;
      el.focus();
      document.execCommand('insertText', false, emoji);
      setShowEmoji(false);
      notify();
    }

    // Close the emoji popover on outside click.
    useEffect(() => {
      if (!showEmoji) return;
      const onDoc = (e: MouseEvent): void => {
        if (emojiWrapRef.current?.contains(e.target as Node)) return;
        setShowEmoji(false);
      };
      document.addEventListener('mousedown', onDoc);
      return () => document.removeEventListener('mousedown', onDoc);
    }, [showEmoji]);

    return (
      <div className="rich-editor-wrap">
        <div className="format-toolbar" aria-disabled={disabled}>
          <button type="button" className="fmt-btn fmt-bold" title="Bold (Ctrl/Cmd+B)"
            onMouseDown={(e) => e.preventDefault()} onClick={() => execFmt('bold')} disabled={disabled}>B</button>
          <button type="button" className="fmt-btn fmt-italic" title="Italic (Ctrl/Cmd+I)"
            onMouseDown={(e) => e.preventDefault()} onClick={() => execFmt('italic')} disabled={disabled}>I</button>
          <button type="button" className="fmt-btn fmt-underline" title="Underline (Ctrl/Cmd+U)"
            onMouseDown={(e) => e.preventDefault()} onClick={() => execFmt('underline')} disabled={disabled}>U</button>
          <button type="button" className="fmt-btn fmt-highlight" title="Highlight"
            onMouseDown={(e) => e.preventDefault()} onClick={() => wrapSel('<mark>', '</mark>')} disabled={disabled}>H</button>
          <span className="fmt-sep" />
          <button type="button" className="fmt-btn fmt-size-sm" title="Smaller text"
            onMouseDown={(e) => e.preventDefault()} onClick={() => wrapSel('<small>', '</small>')} disabled={disabled}>A-</button>
          <button type="button" className="fmt-btn fmt-size-md" title="Normal size"
            onMouseDown={(e) => e.preventDefault()} onClick={() => divRef.current?.focus()} disabled={disabled}>A</button>
          <button type="button" className="fmt-btn fmt-size-lg" title="Bigger text"
            onMouseDown={(e) => e.preventDefault()} onClick={() => wrapSel('<big>', '</big>')} disabled={disabled}>A+</button>
          <span className="fmt-sep" />
          <button type="button" className="fmt-btn fmt-link" title="Insert link"
            onMouseDown={(e) => e.preventDefault()} onClick={insertLink} disabled={disabled}>🔗</button>
          <span ref={emojiWrapRef} className="fmt-emoji-wrap">
            <button type="button" className="fmt-btn fmt-emoji" title="Insert emoji"
              onMouseDown={(e) => e.preventDefault()} onClick={() => setShowEmoji((v) => !v)} disabled={disabled}>😀</button>
            {showEmoji && (
              <div className="emoji-pop" role="menu">
                {EMOJI.map((em) => (
                  <button key={em} type="button" className="emoji-cell"
                    onMouseDown={(ev) => ev.preventDefault()} onClick={() => insertEmoji(em)}>{em}</button>
                ))}
              </div>
            )}
          </span>
        </div>
        <div
          ref={divRef}
          className="chat-input rich-editor"
          contentEditable={!disabled}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          style={style}
          onInput={notify}
          onKeyDown={(e) => {
            if (!multiLine && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onEnter?.();
            }
          }}
        />
      </div>
    );
  },
);
