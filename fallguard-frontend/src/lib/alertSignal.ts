/**
 * Getting someone's attention when a new fall alert arrives: a short alarm tone, a desktop
 * notification and a blinking badge on the tab icon. Browsers only allow sound after the user has
 * clicked something on the page, and desktop notifications only after permission and on
 * https:// or localhost, so enableAlertSignals() must be called from a click.
 */

let audio: AudioContext | null = null;

export function signalsSupported(): { sound: boolean; desktop: boolean } {
  return {
    sound: typeof window !== "undefined" && "AudioContext" in window,
    desktop: typeof window !== "undefined" && "Notification" in window && window.isSecureContext,
  };
}

export function signalsEnabled(): boolean {
  const desktopOk = !signalsSupported().desktop || Notification.permission === "granted";
  return audio?.state === "running" && desktopOk;
}

/** Call from a click: unlocks sound and asks for desktop-notification permission. */
export async function enableAlertSignals(): Promise<void> {
  if (signalsSupported().sound) {
    audio ??= new AudioContext();
    if (audio.state === "suspended") await audio.resume();
  }
  if (signalsSupported().desktop && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

/** Three short high beeps. Silent if sound has not been enabled yet. */
export function playAlarm(): void {
  if (!audio || audio.state !== "running") return;
  const start = audio.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    const t = start + i * 0.35;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.26);
  }
}

export function desktopNotify(title: string, body: string, onClick: () => void): void {
  if (!signalsSupported().desktop || Notification.permission !== "granted") return;
  const n = new Notification(title, { body, tag: "fallguard-alert", requireInteraction: true });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

let baseIcon: string | null = null;
let blink: number | undefined;
let latestCall = 0;
let iconImage: Promise<HTMLImageElement | null> | null = null;

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
}

function loadIcon(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** The tab icon with a red badge showing count (9+ above nine), as a PNG data URL. */
async function badgeIcon(count: number): Promise<string | null> {
  const img = await (iconImage ??= loadIcon(baseIcon!));
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (img) ctx.drawImage(img, 0, 0, size, size);
  const r = 20;
  ctx.fillStyle = '#dc2626';
  ctx.beginPath();
  ctx.arc(size - r, r, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${count > 9 ? 22 : 28}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(count > 9 ? '9+' : String(count), size - r, r + 2);
  return canvas.toDataURL('image/png');
}

/** Shows the number of open fall alerts as a blinking red badge on the tab icon while
 *  count > 0, and the normal icon at 0. The tab title is left as it is, so the tab doesn't
 *  get wider (a title such as "(2) FALL ALERT · ..." pushed the other tabs aside). */
export function setTitleAlert(count: number): void {
  const link = iconLink();
  if (!link) return;
  baseIcon ??= link.href;
  window.clearInterval(blink);
  blink = undefined;
  const call = ++latestCall;
  if (count <= 0) {
    link.href = baseIcon;
    return;
  }
  void badgeIcon(count).then((badge) => {
    if (!badge || call !== latestCall) return; // a newer count arrived meanwhile
    link.href = badge;
    let on = true;
    blink = window.setInterval(() => {
      on = !on;
      link.href = on ? badge : baseIcon!;
    }, 1000);
  });
}
