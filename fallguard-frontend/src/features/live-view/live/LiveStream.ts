import { DetectionBuffer } from "./detections";
import type { LiveOverlay } from "../../../store/uiStore";
import { drawFrame } from "./draw";
import { AccessUnitAssembler, codecFromSps, type AccessUnit } from "./h264";
import { FrameScheduler, type DecodedFrame } from "./playout";
import {
  parseResultMessage,
  parseVideoMessage,
  type ResultMessage,
} from "./protocol";

export interface LiveStreamOptions {
  url: string;
  /** How long frames wait for their detections. 0 shows video as soon as it is decoded. */
  delayMs: number;
  labelText: (label: string) => string;
  /** What to draw over the video; change it later with setOverlay(). */
  overlay: LiveOverlay;
}

/** What a view of the stream wants to hear about. */
export interface LiveStreamListener {
  onResult?: (message: ResultMessage) => void;
  /** "connecting" until the first frame, "live" while frames arrive, "stalled" when they stop. */
  onStatus?: (status: LiveStatus) => void;
  /** Frames shown per second, measured on screen, reported about once a second. */
  onFps?: (fps: number) => void;
}

export type LiveStatus = "connecting" | "live" | "stalled";

/** No new frame for this long = the picture on screen is frozen; say so instead of pretending. */
const STALL_MS = 5000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;

export function supportsLiveStream(): boolean {
  return typeof window !== "undefined" && "VideoDecoder" in window;
}

/**
 * Plays one camera from the stream-hub WebSocket, with the ml-service detections drawn on
 * the frames they belong to. The connection and decoding don't depend on a canvas: a view
 * attaches its canvas while it is on screen, so leaving Live View (or switching between the
 * grid and one camera) doesn't reconnect, and the picture is there at once on return.
 *
 * WebSocket -> pictures grouped by PTS -> WebCodecs decoder -> frames held for delayMs
 * -> drawn with the detection matching their PTS (when a canvas is attached).
 */
export class LiveStream {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private readonly assembler = new AccessUnitAssembler();
  private readonly detections = new DetectionBuffer();
  private readonly scheduler: FrameScheduler;
  private readonly listeners = new Set<LiveStreamListener>();
  private ws: WebSocket | null = null;
  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;
  private waitingForKey = true;
  private ptsOrigin: number | null = null; // WebCodecs timestamps are relative to this (µs precision)
  private current: DecodedFrame | null = null;
  private dirty = false;
  private raf = 0;
  private timer: number | undefined; // keeps the stream going when no canvas is shown (no rAF needed)
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private started = false;
  private retryTimer: number | undefined;
  private retryDelay = RETRY_MIN_MS;
  private lastFrameAt = 0;
  private dueAtFpsSince = 0; // scheduler.due when fpsSince was set
  private fpsSince = 0;
  private fps: number | null = null;
  private status: LiveStatus = "connecting";
  private readonly options: LiveStreamOptions;
  private overlay: LiveOverlay;

  constructor(options: LiveStreamOptions) {
    this.overlay = options.overlay;
    this.options = options;
    this.scheduler = new FrameScheduler(options.delayMs);
  }

  get url(): string {
    return this.options.url;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastFrameAt = performance.now();
    this.fpsSince = this.lastFrameAt;
    this.setStatus("connecting");
    this.connect();
    this.schedule();
  }

  /** Hear about results, status and frame rate; the current status and rate come at once. */
  subscribe(listener: LiveStreamListener): () => void {
    this.listeners.add(listener);
    listener.onStatus?.(this.status);
    if (this.fps !== null) listener.onFps?.(this.fps);
    return () => this.listeners.delete(listener);
  }

  /** Draw on this canvas from now on (the newest frame right away). */
  attach(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas not available");
    this.resizeObserver?.disconnect();
    this.canvas = canvas;
    this.ctx = ctx;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.dirty = true;
    this.schedule();
  }

  /** Stop drawing on this canvas (the stream keeps going). */
  detach(canvas: HTMLCanvasElement): void {
    if (this.canvas !== canvas) return; // another view took over already
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas = null;
    this.ctx = null;
    this.schedule();
  }

  /** Opens the WebSocket. If it closes (stream-hub restart, network drop), retries with backoff. */
  private connect(): void {
    // Older browsers reject relative or http(s) WebSocket URLs: make it absolute ws(s)://.
    const target = new URL(this.options.url, window.location.href);
    target.protocol = target.protocol === "https:" ? "wss:" : target.protocol === "http:" ? "ws:" : target.protocol;
    const ws = new WebSocket(target);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.retryDelay = RETRY_MIN_MS;
    };
    ws.onmessage = (event) => this.onMessage(event);
    ws.onerror = () => {
      if (!this.disposed)
        console.error("Live video WebSocket error:", this.options.url);
    };
    ws.onclose = () => {
      if (this.disposed || this.ws !== ws) return;
      this.resetDecoding();
      this.retryTimer = window.setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    };
    this.ws = ws;
  }

  /** A new connection starts a new stream: wait for its first keyframe. */
  private resetDecoding(): void {
    this.assembler.reset();
    this.detections.clear();
    this.scheduler.clear();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
    this.codec = null;
    this.ptsOrigin = null;
    this.waitingForKey = true;
  }

  private setStatus(status: LiveStatus): void {
    if (status === this.status && status !== "connecting") return;
    this.status = status;
    for (const l of this.listeners) l.onStatus?.(status);
  }

  /** Redraws the current frame with other overlays (no reconnect). */
  setOverlay(overlay: LiveOverlay): void {
    this.overlay = overlay;
    this.dirty = true;
  }

  stop(): void {
    this.disposed = true;
    window.clearTimeout(this.retryTimer);
    cancelAnimationFrame(this.raf);
    window.clearInterval(this.timer);
    this.resizeObserver?.disconnect();
    this.ws?.close();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.scheduler.clear();
    this.current?.image.close();
    this.current = null;
    this.listeners.clear();
  }

  private onMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      const message = parseResultMessage(event.data);
      if (!message) return;
      if (message.type === "detections") {
        this.detections.add(message);
        // Arrived after its frame was drawn (delay too short): redraw with it.
        if (this.current && message.pts <= this.current.pts) this.dirty = true;
      }
      for (const l of this.listeners) l.onResult?.(message);
      return;
    }

    const chunk = parseVideoMessage(event.data as ArrayBuffer);
    if (!chunk) return;
    const picture = this.assembler.push(chunk);
    if (picture) this.decode(picture);
  }

  private decode(picture: AccessUnit): void {
    if (picture.sps) {
      const codec = codecFromSps(picture.sps);
      if (codec !== this.codec || !this.decoder) this.configure(codec);
    } else if (!this.decoder && this.codec && picture.key) {
      this.configure(this.codec); // recovering from a decoder error
    }

    if (!this.decoder || this.decoder.state !== "configured") return;
    if (this.waitingForKey && !picture.key) return;
    this.waitingForKey = false;

    this.ptsOrigin ??= picture.pts;
    this.decoder.decode(
      new EncodedVideoChunk({
        type: picture.key ? "key" : "delta",
        timestamp: (picture.pts - this.ptsOrigin) * 1000,
        data: picture.data,
      }),
    );
  }

  private configure(codec: string): void {
    if (!this.decoder || this.decoder.state === "closed") {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: (error) => this.onDecoderError(error),
      });
    }
    // No description: the decoder expects Annex B, which is what stream-hub sends.
    this.decoder.configure({ codec, optimizeForLatency: true });
    this.codec = codec;
    this.waitingForKey = true;
  }

  private onDecoderError(error: DOMException): void {
    console.warn(
      "Live video decoder error, waiting for the next keyframe:",
      error.message,
    );
    this.decoder = null; // a decoder that reported an error is closed
    this.waitingForKey = true;
  }

  private onFrame(frame: VideoFrame): void {
    const pts = frame.timestamp / 1000 + (this.ptsOrigin ?? 0);
    createImageBitmap(frame)
      .then((image) => {
        if (this.disposed) image.close();
        else this.scheduler.push({ pts, image });
      })
      .catch(() => {})
      .finally(() => frame.close());
  }

  /** With a canvas: every animation frame. Without one: a light timer that only keeps the
   *  newest frame (rAF isn't needed, and stops in background tabs anyway). */
  private schedule(): void {
    if (this.disposed || !this.started) return;
    cancelAnimationFrame(this.raf);
    window.clearInterval(this.timer);
    this.timer = undefined;
    if (this.canvas) this.raf = requestAnimationFrame(this.render);
    else this.timer = window.setInterval(() => this.tick(performance.now()), 100);
  }

  private render = (): void => {
    if (this.disposed || !this.canvas) return;
    this.raf = requestAnimationFrame(this.render);
    this.tick(performance.now());
    if (!this.dirty || !this.current || !this.ctx) return;
    this.dirty = false;
    drawFrame(
      this.ctx,
      this.current.image,
      this.detections.at(this.current.pts),
      this.options.labelText,
      window.devicePixelRatio || 1,
      this.overlay,
    );
  };

  /** Takes the newest due frame, and keeps the status and frame rate current. */
  private tick(now: number): void {
    const next = this.scheduler.take(now);
    if (next) {
      this.current?.image.close();
      this.current = next;
      this.dirty = true;
      this.lastFrameAt = now;
      this.setStatus("live");
    } else if (this.status === "live" && now - this.lastFrameAt > STALL_MS) {
      this.setStatus("stalled");
    }
    if (now - this.fpsSince >= 1000) {
      // Every frame that came due counts, also ones skipped between two 100 ms ticks while no
      // canvas is shown: the stream's own rate, right as soon as a view attaches.
      this.fps = Math.round(((this.scheduler.due - this.dueAtFpsSince) * 1000) / (now - this.fpsSince));
      for (const l of this.listeners) l.onFps?.(this.fps);
      this.dueAtFpsSince = this.scheduler.due;
      this.fpsSince = now;
    }
  }

  private resize(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (
      width > 0 &&
      height > 0 &&
      (canvas.width !== width || canvas.height !== height)
    ) {
      canvas.width = width;
      canvas.height = height;
      this.dirty = true;
    }
  }
}
