// Apply data-platform & data-skin to <html> based on OS + user prefs.
// `prefs` is unavailable until the user has unlocked the session, so we
// gracefully fall back to the OS default if getPrefs throws.

import type { AppApi, Platform } from '@shared/types.js';
import type { Theme } from '@shared/schemas';

export async function applyPlatformTheme(api: AppApi): Promise<void> {
  let platform: Platform = 'linux';
  try {
    platform = await api.getPlatform();
  } catch {
    // Fallback by sniffing userAgent.
    const ua = navigator.userAgent;
    platform = ua.includes('Mac') ? 'mac' : ua.includes('Win') ? 'windows' : 'linux';
  }
  document.documentElement.setAttribute('data-platform', platform);

  try {
    const prefs = await api.getPrefs();
    if (prefs.skin && prefs.skin !== 'auto') {
      document.documentElement.setAttribute('data-skin', prefs.skin);
    } else {
      document.documentElement.removeAttribute('data-skin');
    }
    applyThemeAttributes(prefs.theme);
  } catch {
    // Pre-unlock: no prefs yet, leave platform default.
    document.documentElement.removeAttribute('data-skin');
  }

  // Register a persistent live-update listener for this window so that every
  // window type (buddy list, IM, game, etc.) reacts to theme changes made in
  // Settings — even if the component doesn't subscribe separately.
  api.onThemeChanged((theme) => applyThemeAttributes(theme));
}

// Pushes theme attributes onto <html>. Called once at startup and again
// whenever the user changes theme prefs at runtime.
export function applyThemeAttributes(theme: Theme): void {
  const html = document.documentElement;
  html.setAttribute('data-window-theme', theme.windowTheme);
  html.setAttribute('data-chat-theme', theme.chatTheme);
  const colorMode = theme.colorMode || 'light';
  html.setAttribute('data-color-mode', colorMode);
  if (colorMode === 'dark') {
    // In dark mode use dark-appropriate bubble colors so light saved colors
    // don't override the CSS-variable dark defaults via inline style.
    html.style.setProperty('--my-bubble', '#1e3a5f');
    html.style.setProperty('--their-bubble', '#2a2a3e');
  } else {
    html.style.setProperty('--my-bubble', theme.myBubbleColor || '#d8f0ff');
    html.style.setProperty('--their-bubble', theme.theirBubbleColor || '#eeeeee');
  }
}

