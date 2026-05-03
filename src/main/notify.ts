/**
 * Desktop notification helpers (Electron main-process only).
 *
 * Uses the Electron Notification API which delegates to the OS notification
 * system (macOS NC, Windows Action Center, Linux libnotify).
 *
 * Guards every call with the `notificationsEnabled` pref so the user can
 * silence them globally from Settings → Audio.
 */
import { Notification } from 'electron';
import path from 'node:path';

// Icon path relative to the Electron resources directory.
const ICON_PATH = path.join(__dirname, '../../resources/icon.png');

let _notificationsEnabled = true;

/** Call this whenever the prefs change so notifications respect the setting. */
export function setNotificationsEnabled(enabled: boolean): void {
  _notificationsEnabled = enabled;
}

/** Show a notification for an incoming 1:1 IM. */
export function notifyIm(screenName: string, preview: string): void {
  if (!_notificationsEnabled) return;
  if (!Notification.isSupported()) return;
  new Notification({
    title: screenName,
    body: preview.length > 120 ? preview.slice(0, 117) + '…' : preview,
    icon: ICON_PATH,
    silent: true, // Buzz handles its own sounds via Web Audio
  }).show();
}

/** Show a notification for a @mention or room message. */
export function notifyMention(roomName: string, senderName: string, preview: string): void {
  if (!_notificationsEnabled) return;
  if (!Notification.isSupported()) return;
  new Notification({
    title: `${senderName} in ${roomName}`,
    body: preview.length > 120 ? preview.slice(0, 117) + '…' : preview,
    icon: ICON_PATH,
    silent: true,
  }).show();
}
