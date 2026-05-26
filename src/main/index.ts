import { app, BrowserWindow, ipcMain, nativeImage, protocol, session as electronSession, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { registerIpc } from './ipc/handlers.js';
import { Session } from './session.js';
import { migrateLegacy } from './profiles.js';
import { initUpdater, registerUpdaterIpc } from './updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const isDev = !!process.env['ELECTRON_RENDERER_URL'];

// Set the user-facing app name as early as possible so the menu bar, dock,
// and window titles all read "Buzz" instead of "Electron" in dev.
app.setName('Buzz');
process.title = 'Buzz';

// Register buzz-file:// as a privileged scheme so <img> tags can load
// local files served from the main process without violating the CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: 'buzz-file', privileges: { secure: true, supportFetchAPI: false, bypassCSP: false } },
]);

// Resolve the bundled app icon. In dev, `here` is `<repo>/out/main`, so the
// icon lives two dirs up under `resources/`. In a packaged build, both
// `here` and the `resources/` dir end up siblings inside the app's resources,
// so the same relative path resolves correctly.
const APP_ICON_PATH = path.resolve(here, '../../resources/icon.png');
const APP_ICON = nativeImage.createFromPath(APP_ICON_PATH);
if (process.platform === 'darwin' && app.dock && !APP_ICON.isEmpty()) {
  app.dock.setIcon(APP_ICON);
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
let shutdownStarted = false;
let shutdownMayQuit = false;

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
        "img-src 'self' data: buzz-file: " + devOrigin,
        "font-src 'self' data: " + devOrigin,
        "connect-src 'self' " + devOrigin + ' ' + devWs,
        "media-src 'self' blob: " + devOrigin,
      ].join('; ')
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: buzz-file:",
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
function rendererTarget(page: 'signon' | 'buddylist' | 'im' | 'chat' | 'videocall' | 'game' | 'settings' | 'meshdebug'): {
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
const gameWindows = new Map<string, BrowserWindow>();
let settingsWin: BrowserWindow | null = null;
let meshDebugWin: BrowserWindow | null = null;

function beginShutdown(): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const timeout = setTimeout(() => {
    console.warn('[main] Shutdown timeout; forcing app exit.');
    app.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  void session.lock()
    .catch((err) => console.warn('[main] Error while locking session during shutdown:', err))
    .finally(() => {
      clearTimeout(timeout);
      shutdownMayQuit = true;
      app.quit();
    });
}

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

function loadInto(win: BrowserWindow, page: 'signon' | 'buddylist' | 'im' | 'chat' | 'videocall' | 'game' | 'settings' | 'meshdebug', hash = ''): void {
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
    height: 500,
    resizable: false,
    minimizable: true,
    maximizable: false,
    frame: false,
    title: 'Sign On',
    transparent: true,
    icon: APP_ICON,
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
    transparent: true,
    icon: APP_ICON,
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'buddylist');
  win.on('closed', () => {
    if (buddyListWin === win) buddyListWin = null;
  });
  buddyListWin = win;
  return win;
}

function openSettingsWindow(): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return settingsWin;
  }
  const win = new BrowserWindow({
    width: 560,
    height: 420,
    minWidth: 480,
    minHeight: 340,
    frame: false,
    title: 'Settings',
    transparent: true,
    icon: APP_ICON,
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'settings');
  win.on('closed', () => {
    if (settingsWin === win) settingsWin = null;
  });
  settingsWin = win;
  return win;
}

function openMeshDebugWindow(): BrowserWindow {
  if (meshDebugWin && !meshDebugWin.isDestroyed()) {
    meshDebugWin.focus();
    return meshDebugWin;
  }
  const win = new BrowserWindow({
    width: 620,
    height: 480,
    minWidth: 500,
    minHeight: 360,
    frame: false,
    title: 'Buzz Mesh Debug',
    transparent: true,
    icon: APP_ICON,
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'meshdebug');
  win.on('closed', () => {
    if (meshDebugWin === win) meshDebugWin = null;
  });
  meshDebugWin = win;
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
    transparent: true,
    icon: APP_ICON,
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
    transparent: true,
    icon: APP_ICON,
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
    icon: APP_ICON,
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'videocall', peerId);
  win.on('closed', () => {
    if (videoCallWindows.get(peerId) === win) videoCallWindows.delete(peerId);
  });
  videoCallWindows.set(peerId, win);
  return win;
}

export function openGameWindow(peerId: string, kind: string, initiator = false): BrowserWindow {
  const key = `${peerId}:${kind}`;
  const cached = gameWindows.get(key);
  if (cached && !cached.isDestroyed()) {
    cached.focus();
    return cached;
  }
  const win = new BrowserWindow({
    width: 460,
    height: 540,
    minWidth: 380,
    minHeight: 460,
    frame: false,
    title: 'Games',
    transparent: true,
    icon: APP_ICON,
    webPreferences: commonWebPrefs(),
  });
  loadInto(win, 'game', `${peerId}:${kind}:${initiator ? '1' : '0'}`);
  win.on('closed', () => {
    if (gameWindows.get(key) === win) gameWindows.delete(key);
  });
  gameWindows.set(key, win);
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

/** Close every session window (IM, chat, video-call, buddy-list) without
 * quitting the app, then surface the Sign On window again. Called both on
 * explicit sign-out and when the app is about to quit. */
function closeSessionWindows(): void {
  for (const win of [...imWindows.values(), ...chatWindows.values(), ...videoCallWindows.values()]) {
    if (!win.isDestroyed()) win.close();
  }
  if (buddyListWin && !buddyListWin.isDestroyed()) buddyListWin.close();
}

app.whenReady().then(() => {
  // Migrate any legacy single-profile install (userData/keystore.bin +
  // buzz.sqlite) into a profile dir so existing users keep their identity.
  migrateLegacy();
  installCsp();

  // Serve completed file-transfer files via buzz-file://<transferId>.
  // Only resolves a path if the transfer exists and is 'complete' in the DB.
  protocol.handle('buzz-file', (request) => {
    try {
      const transferId = new URL(request.url).hostname;
      if (!transferId || !/^[\w-]{1,128}$/.test(transferId)) {
        return new Response('Bad request', { status: 400 });
      }
      const db = session.db;
      if (!db) return new Response('Not ready', { status: 503 });
      const row = db.prepare(
        "SELECT saved_path FROM transfers WHERE id=? AND status='complete'",
      ).get(transferId) as { saved_path: string } | undefined;
      if (!row?.saved_path) return new Response('Not found', { status: 404 });
      // Guard against path traversal: saved_path should be an absolute path
      // set by the main process. Verify the file exists before serving.
      if (row.saved_path.includes('\0') || !path.isAbsolute(row.saved_path)) {
        return new Response('Forbidden', { status: 403 });
      }
      const filePath = path.resolve(row.saved_path);
      if (!fs.existsSync(filePath)) return new Response('Gone', { status: 410 });
      const realPath = fs.realpathSync(filePath);
      const data = fs.readFileSync(realPath);
      const ext = path.extname(realPath).toLowerCase().slice(1);
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      };
      const contentType = mimeMap[ext] ?? 'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': contentType } });
    } catch {
      return new Response('Error', { status: 500 });
    }
  });

  registerIpc(session, {
    onLocked: () => {
      closeSessionWindows();
      openSignOn();
    },
  });
  // Window-management helpers used by the buddy list to open IM windows.
  ipcMain.handle('windows:openIm', (_e, peerId: string) => {
    if (typeof peerId !== 'string') throw new Error('bad peerId');
    openImWindow(peerId);
  });
  ipcMain.handle('windows:openBuddyList', () => {
    openBuddyList();
  });
  ipcMain.handle('windows:openSettings', () => {
    openSettingsWindow();
  });
  ipcMain.handle('windows:openMeshDebug', () => {
    openMeshDebugWindow();
  });
  ipcMain.handle('windows:openChat', (_e, roomId: string) => {
    if (typeof roomId !== 'string') throw new Error('bad roomId');
    openChatWindow(roomId);
  });
  ipcMain.handle('windows:openVideoCall', (_e, peerId: string) => {
    if (typeof peerId !== 'string') throw new Error('bad peerId');
    openVideoCallWindow(peerId);
  });
  ipcMain.handle('windows:openGame', (_e, peerId: string, kind: string, initiator?: boolean) => {
    if (typeof peerId !== 'string' || typeof kind !== 'string') throw new Error('bad args');
    openGameWindow(peerId, kind, initiator ?? false);
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

  // Auto-updater: set up IPC handles and broadcast update events to all
  // open renderer windows. The initUpdater callback fires on every status
  // change (checking / available / downloading / downloaded / error).
  registerUpdaterIpc();
  initUpdater((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('evt:updateStatus', status);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    beginShutdown();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) openSignOn();
});

app.on('before-quit', (event) => {
  if (shutdownMayQuit) return;
  event.preventDefault();
  beginShutdown();
});
