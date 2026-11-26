import { LiveStream } from "./LiveStream";

/**
 * One live connection per camera for the whole app. Views borrow it (acquire / release), so
 * leaving Live View, opening one camera or going back to the grid doesn't reconnect: the
 * stream keeps decoding and the newest picture is there at once.
 *
 * A stream nobody shows stays open KEEP_IDLE_MS, then closes; at most MAX_IDLE stay open
 * unseen (the oldest close first). All close on sign-out (closeAllLiveStreams). This is only
 * the browser's view: cameras keep streaming, being analysed and recorded on the server
 * whether or not anyone watches.
 */
const KEEP_IDLE_MS = 30 * 60 * 1000;
const MAX_IDLE = 12;

interface Entry {
  stream: LiveStream;
  users: number;
  idleSince: number | null;
  timer?: number;
}

const streams = new Map<string, Entry>();

export function acquireLiveStream(url: string, make: () => LiveStream): LiveStream {
  let e = streams.get(url);
  if (!e) {
    e = { stream: make(), users: 0, idleSince: null };
    streams.set(url, e);
    e.stream.start();
  }
  e.users++;
  e.idleSince = null;
  window.clearTimeout(e.timer);
  return e.stream;
}

export function releaseLiveStream(url: string): void {
  const e = streams.get(url);
  if (!e) return;
  e.users = Math.max(0, e.users - 1);
  if (e.users > 0) return;
  e.idleSince = Date.now();
  e.timer = window.setTimeout(() => close(url), KEEP_IDLE_MS);
  // Too many unseen streams: close the ones unseen the longest.
  const idle = [...streams.entries()].filter(([, x]) => x.users === 0)
    .sort(([, a], [, b]) => (a.idleSince ?? 0) - (b.idleSince ?? 0));
  for (const [u] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) close(u);
}

/** Sign-out: every stream closes, also ones still shown (their views are going away). */
export function closeAllLiveStreams(): void {
  for (const url of Array.from(streams.keys())) close(url, true);
}

function close(url: string, force = false): void {
  const e = streams.get(url);
  if (!e || (e.users > 0 && !force)) return;
  window.clearTimeout(e.timer);
  e.stream.stop();
  streams.delete(url);
}
