export interface DecodedFrame {
  pts: number;
  image: ImageBitmap;
}

/**
 * Holds decoded frames and releases each one `delayMs` after the earliest moment it
 * could have been shown. Detections reach the browser after the video they describe
 * (decoding and inference take time), so the delay lets every frame be drawn together
 * with the detection that matches its PTS.
 *
 * Camera PTS are mapped to local time with the smallest (arrival time - PTS) seen over
 * the last few seconds: the fastest-arriving frames define "on time", and the sliding
 * window follows clock drift between the camera and the browser.
 */
export class FrameScheduler {
  private queue: DecodedFrame[] = [];
  private lags: { at: number; lag: number }[] = [];
  private readonly delayMs: number;
  private readonly windowMs: number;
  private readonly maxQueued: number;

  constructor(delayMs: number, windowMs = 3000, maxQueued = 30) {
    this.delayMs = delayMs;
    this.windowMs = windowMs;
    this.maxQueued = maxQueued;
  }

  push(frame: DecodedFrame, now = performance.now()): void {
    this.lags.push({ at: now, lag: now - frame.pts });
    while (this.lags.length > 1 && this.lags[0].at < now - this.windowMs)
      this.lags.shift();

    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].pts > frame.pts) i--;
    this.queue.splice(i, 0, frame);
    while (this.queue.length > this.maxQueued)
      this.queue.shift()!.image.close();
  }

  /** The newest frame that is due, or null. Older due frames are skipped and released. */
  take(now = performance.now()): DecodedFrame | null {
    if (this.queue.length === 0) return null;
    const base = Math.min(...this.lags.map((l) => l.lag));
    let due: DecodedFrame | null = null;
    while (
      this.queue.length > 0 &&
      this.queue[0].pts + base + this.delayMs <= now
    ) {
      due?.image.close();
      due = this.queue.shift()!;
    }
    return due;
  }

  clear(): void {
    for (const f of this.queue) f.image.close();
    this.queue = [];
    this.lags = [];
  }
}
