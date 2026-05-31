// Local-only usage counters. Opt-in via Prefs.telemetryEnabled. Nothing is
// uploaded anywhere — these numbers are surfaced only in Settings → About so
// the user can see (and reset) what their own client has been doing.

import type { Db } from './db/open.js';
import * as repos from './db/repos.js';
import type { Prefs } from '@shared/schemas';

type Counters = Prefs['telemetry'];

function emptyCounters(): Counters {
  return { imsSent: 0, callsTotal: 0, callMillis: 0, voiceJoins: 0, screenShares: 0, sinceTs: Date.now() };
}

function bump(db: Db, patch: Partial<Counters>): void {
  const prefs = repos.getPrefs(db);
  if (!prefs.telemetryEnabled) return;
  const cur = prefs.telemetry ?? emptyCounters();
  const next: Counters = {
    imsSent: cur.imsSent + (patch.imsSent ?? 0),
    callsTotal: cur.callsTotal + (patch.callsTotal ?? 0),
    callMillis: cur.callMillis + (patch.callMillis ?? 0),
    voiceJoins: cur.voiceJoins + (patch.voiceJoins ?? 0),
    screenShares: cur.screenShares + (patch.screenShares ?? 0),
    sinceTs: cur.sinceTs || Date.now(),
  };
  repos.setPrefs(db, { telemetry: next });
}

export const telemetry = {
  recordIm: (db: Db): void => bump(db, { imsSent: 1 }),
  recordCall: (db: Db, durMs: number): void => bump(db, { callsTotal: 1, callMillis: Math.max(0, Math.round(durMs)) }),
  recordVoiceJoin: (db: Db): void => bump(db, { voiceJoins: 1 }),
  recordScreenShare: (db: Db): void => bump(db, { screenShares: 1 }),
  snapshot: (db: Db): Counters => repos.getPrefs(db).telemetry ?? emptyCounters(),
  reset: (db: Db): Counters => {
    const next = emptyCounters();
    repos.setPrefs(db, { telemetry: next });
    return next;
  },
};
