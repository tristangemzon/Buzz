import { app, BrowserWindow, ipcMain, session as electronSession, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerIpc } from './ipc/handlers.js';
import { Session } from './session.js';
import { migrateLegacy } from './profiles.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

// CSP — strict in production, relaxed in dev so Vite's HMR + react-refresh
// inline bootstrap can run. The dev server origin is whatever Vite gave us.
function installCsp(): void {
  const devOrigin = process.env['ELECTRON_RENDERER_URL'] ?? '';
  const devWs = devOrigin.replace(/^http/, 'ws');
  const policy = isDev
    ? [
        "default-src 'self' " + devOrigin,
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' " + devOrigin,
        "style-src 'self' 'unsafe-inline' " + devOrigin,
        "img-src 'self' data: " + devOrigin,
        "font-src 'self' data: " + devOrigin,
        "connect-src 'self' " + devOrigin + ' ' + devWs,
        "media-src 'self' blob: " + devOrigin,
      ].join('; ')
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "media-src 'self' blob:",
      ].join('; ');

  electronSession.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

// Resolve the renderer URL/file for a given page id (matches Vite multi-entry).
function rendererTarget(page: 'signon' | 'buddylist' | 'im' | 'chat' | 'videocall'): {
  url?: string;
  file?: string;
} {
  if (isDev) {
    return { url: `${process.env['ELECTRON_RENDERER_URL']}/${page}.html` };
  }
  return { file: path.resolve(here, `../renderer/${page}.html`) };
}

const session = new Session();
let signOnWin: BrowserWindow | null = null;
let buddyListWin: BrowserWindow | null = null;
const imWindows = new Map<string, BrowserWindow>();
const chatWindows = new Map<string, BrowserWindow>();
const videoCallWindows = new Map<string, BrowserWindow>();

function commonWebPrefs() {
  return {
    // contextIsolation gives us the security boundary we need; sandbox: true
    // would force the preload to be CJS, but electron-vite emits ESM here.
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.resolve(here, '../preload/index.mjs'),
  } as const;
}

function loadInto(win: BrowserWindow, page: 'signon' | 'buddylist' | 'im' | 'chat' | 'videocall', hash = ''): void {
  const t = rendererTarget(page);
  const suffix = hash ? `#${encodeURIComponent(hash)}` : '';
  if (t.url) void win.loadURL(t.url + suffix);
  else if (t.file) void win.loadFile(t.file, hash ? { hash } : undefined);
}

function openSignOn(): BrowserWindow {
  if (signOnWin && !signOnWin.isDestroyed()) {
    signOnWin.focus();
    return signOnWin;
  }
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    resizable: false,
    minimizable: true,
    maximizable: false,
    frame: false,
    title: 'Sign On',
    backgroundColor: '#ece9d8',
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'signon');
  win.on('closed', () => {
    if (signOnWin === win) signOnWin = null;
  });
  signOnWin = win;
  return win;
}

function openBuddyList(): BrowserWindow {
  if (buddyListWin && !buddyListWin.isDestroyed()) {
    buddyListWin.focus();
    return buddyListWin;
  }
  const win = new BrowserWindow({
    width: 360,
    height: 600,
    minWidth: 320,
    minHeight: 360,
    frame: false,
    title: 'Buddy List',
    backgroundColor: '#ece9d8',
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'buddylist');
  win.on('closed', () => {
    if (buddyListWin === win) buddyListWin = null;
  });
  buddyListWin = win;
  return win;
}

export function openImWindow(peerId: string): BrowserWindow {
  const cached = imWindows.get(peerId);
  if (cached && !cached.isDestroyed()) {
    cached.focus();
    return cached;
  }
  const win = new BrowserWindow({
    width: 480,
    height: 420,
    frame: false,
    title: 'Instant Message',
    backgroundColor: '#ece9d8',
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'im', peerId);
  win.on('closed', () => {
    if (imWindows.get(peerId) === win) imWindows.delete(peerId);
  });
  imWindows.set(peerId, win);
  return win;
}

export function openChatWindow(roomId: string): BrowserWindow {
  const cached = chatWindows.get(roomId);
  if (cached && !cached.isDestroyed()) {
    cached.focus();
    return cached;
  }
  const win = new BrowserWindow({
    width: 540,
    height: 480,
    minWidth: 380,
    minHeight: 320,
    frame: false,
    title: 'Chat Room',
    backgroundColor: '#ece9d8',
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'chat', roomId);
  win.on('closed', () => {
    if (chatWindows.get(roomId) === win) chatWindows.delete(roomId);
  });
  chatWindows.set(roomId, win);
  return win;
}

export function openVideoCallWindow(peerId: string): BrowserWindow {
  const cached = videoCallWindows.get(peerId);
  if (cached && !cached.isDestroyed()) {
    cached.focus();
    return cached;
  }
  const win = new BrowserWindow({
    width: 360,
    height: 320,
    minWidth: 280,
    minHeight: 240,
    frame: false,
    title: 'Video Chat',
    backgroundColor: '#000000',
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'videocall', peerId);
  win.on('closed', () => {
    if (videoCallWindows.get(peerId) === win) videoCallWindows.delete(peerId);
  });
  videoCallWindows.set(peerId, win);
  return win;
}

// Strict default for webContents: deny new window opens to external URLs except
// safe http(s) which we hand off to the OS browser.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (
      !url.startsWith('file://') &&
      !url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '__nope__')
    ) {
      e.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    }
  });
});

app.whenReady().then(() => {
  // Migrate any legacy single-profile install (userData/keystore.bin +
  // buzz.sqlite) into a profile dir so existing users keep their identity.
  migrateLegacy();
  installCsp();
  registerIpc(session);
  // Window-management helpers used by the buddy list to open IM windows.
  ipcMain.handle('windows:openIm', (_e, peerId: string) => {
    if (typeof peerId !== 'string') throw new Error('bad peerId');
    openImWindow(peerId);
  });
  ipcMain.handle('windows:openBuddyList', () => {
    openBuddyList();
  });
  ipcMain.handle('windows:openChat', (_e, roomId: string) => {
    if (typeof roomId !== 'string') throw new Error('bad roomId');
    openChatWindow(roomId);
  });
  ipcMain.handle('windows:openVideoCall', (_e, peerId: string) => {
    if (typeof peerId !== 'string') throw new Error('bad peerId');
    openVideoCallWindow(peerId);
  });

  // Custom-chrome window controls. The renderer's titlebar exposes
  // minimize / maximize / close buttons that route through these.
  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });
  ipcMain.handle('window:toggleMax', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  ipcMain.handle('window:isMaximizable', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximizable() ?? false;
  });

  openSignOn();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void session.lock().finally(() => app.quit());
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) openSignOn();
});

app.on('before-quit', () => {
  void session.lock().catch(() => {});
});
