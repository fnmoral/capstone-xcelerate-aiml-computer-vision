/**
 * Getting someone's attention when a new fall alert arrives: a short alarm tone, a desktop
 * notification and a blinking tab title. Browsers only allow sound after the user has
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

let baseTitle: string | null = null;
let blink: number | undefined;

/** Blinks "(n) FALL ALERT" in the tab title while n > 0; restores the title at 0. */
export function setTitleAlert(count: number): void {
  baseTitle ??= document.title;
  window.clearInterval(blink);
  blink = undefined;
  if (count <= 0) {
    document.title = baseTitle;
    return;
  }
  const alertTitle = `(${count}) FALL ALERT · ${baseTitle}`;
  document.title = alertTitle;
  blink = window.setInterval(() => {
    document.title = document.title === alertTitle ? baseTitle! : alertTitle;
  }, 1000);
}
