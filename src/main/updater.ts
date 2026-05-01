// Auto-updater — wraps electron-updater to check GitHub Releases.
//
// How it works end-to-end:
//   1. Pack the app with `npm run pack:mac` / `npm run pack:win` — electron-builder
//      builds the installer AND uploads it to a GitHub Release together with a
//      `latest.yml` / `latest-mac.yml` manifest file that describes the version,
//      SHA512, and download URL.
//   2. At runtime `autoUpdater.checkForUpdates()` fetches that manifest from
//      the public GitHub API (no token needed for a public repo).
//   3. If a newer version is found the update is downloaded silently in the
//      background and the renderer is notified via `evt:updateStatus`.
//   4. When the user clicks "Install & Restart" in the Settings modal,
//      `autoUpdater.quitAndInstall()` relaunches the app with the new version.
//
// In dev mode (ELECTRON_RENDERER_URL set) the updater is a no-op because
// there is no packaged `app-update.yml` to read.

import { ipcMain, app, shell } from 'electron';
import updaterPkg from 'electron-updater';
const { autoUpdater } = updaterPkg;
import type { UpdateStatus } from '@shared/types.js';

const isDev = !!process.env['ELECTRON_RENDERER_URL'];
const isMac = process.platform === 'darwin';

// On macOS, Squirrel.Mac requires a valid Apple code signature to install
// updates via quitAndInstall(). Since CI builds are unsigned, we bypass the
// in-app install and open the GitHub Releases page instead.
const RELEASES_URL = 'https://github.com/tristangemzon/Buzz/releases/latest';

let currentStatus: UpdateStatus = { phase: 'idle' };
let broadcastFn: ((status: UpdateStatus) => void) | null = null;

function broadcast(status: UpdateStatus): void {
  currentStatus = status;
  broadcastFn?.(status);
}

export function initUpdater(broadcast_: (status: UpdateStatus) => void): void {
  broadcastFn = broadcast_;

  if (isDev) {
    // Skip in dev — no packaged app-update.yml is present.
    return;
  }

  // Don't auto-download; let the user decide to install.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    broadcast({ phase: 'checking' });
  });

  autoUpdater.on('update-not-available', () => {
    broadcast({ phase: 'not-available', currentVersion: app.getVersion() });
  });

  autoUpdater.on('update-available', (info) => {
    // On macOS, skip the in-app download/install flow (requires code signing).
    // Surface a special phase so the UI shows "Open Download Page" instead.
    if (isMac) {
      broadcast({ phase: 'available-external', version: String(info.version) });
      return;
    }
    broadcast({ phase: 'available', version: String(info.version) });
  });

  autoUpdater.on('download-progress', (p) => {
    broadcast({ phase: 'downloading', percent: Math.round(p.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ phase: 'downloaded', version: String(info.version) });
  });

  autoUpdater.on('error', (err: Error) => {
    // On macOS, Squirrel.Mac rejects unsigned updates with a code-signature
    // error. Treat this as "update available but needs manual install" so the
    // UI shows a helpful "Open Download Page" button rather than a raw error.
    if (isMac && err.message.includes('code failed to satisfy specified code requirement')) {
      broadcast({ phase: 'available-external', version: '' });
      return;
    }
    broadcast({ phase: 'error', message: err.message ?? String(err) });
  });
}

export function registerUpdaterIpc(): void {
  // Renderer → main: check for updates now
  ipcMain.handle('updates:check', async () => {
    if (isDev) {
      broadcast({ phase: 'not-available', currentVersion: app.getVersion() + ' (dev)' });
      return currentStatus;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      broadcast({ phase: 'error', message: (err as Error).message ?? String(err) });
    }
    return currentStatus;
  });

  // Renderer → main: start downloading the available update (or open browser on macOS)
  ipcMain.handle('updates:download', async () => {
    if (isDev) return;
    if (isMac) {
      await shell.openExternal(RELEASES_URL);
      return;
    }
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      broadcast({ phase: 'error', message: (err as Error).message ?? String(err) });
    }
  });

  // Renderer → main: open releases page directly (macOS manual-update fallback)
  ipcMain.handle('updates:openReleasePage', async () => {
    await shell.openExternal(RELEASES_URL);
  });

  // Renderer → main: quit and install the downloaded update
  ipcMain.handle('updates:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // Renderer → main: get the last known status without triggering a check
  ipcMain.handle('updates:getStatus', () => currentStatus);

  // Renderer → main: current app version
  ipcMain.handle('updates:getVersion', () => app.getVersion());
}
