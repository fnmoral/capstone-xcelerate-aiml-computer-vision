import { DetectionBuffer } from "./detections";
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
  canvas: HTMLCanvasElement;
  /** How long frames wait for their detections. 0 shows video as soon as it is decoded. */
  delayMs: number;
  labelText: (label: string) => string;
  onResult?: (message: ResultMessage) => void;
}

export function supportsLiveStream(): boolean {
  return typeof window !== "undefined" && "VideoDecoder" in window;
}

/**
 * Plays one camera from the stream-hub WebSocket on a canvas, with the ml-service
 * detections drawn on the frames they belong to.
 *
 * WebSocket -> pictures grouped by PTS -> WebCodecs decoder -> frames held for delayMs
 * -> drawn with the detection matching their PTS.
 */
export class LiveStream {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly assembler = new AccessUnitAssembler();
  private readonly detections = new DetectionBuffer();
  private readonly scheduler: FrameScheduler;
  private ws: WebSocket | null = null;
  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;
  private waitingForKey = true;
  private ptsOrigin: number | null = null; // WebCodecs timestamps are relative to this (µs precision)
  private current: DecodedFrame | null = null;
  private dirty = false;
  private raf = 0;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private readonly options: LiveStreamOptions;

  constructor(options: LiveStreamOptions) {
    this.options = options;
    const ctx = options.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas not available");
    this.ctx = ctx;
    this.scheduler = new FrameScheduler(options.delayMs);
  }

  start(): void {
    const ws = new WebSocket(this.options.url);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => this.onMessage(event);
    ws.onerror = () => {
      if (!this.disposed)
        console.error("Live video WebSocket error:", this.options.url);
    };
    this.ws = ws;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.options.canvas);
    this.resize();
    this.raf = requestAnimationFrame(this.render);
  }

  stop(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.ws?.close();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.scheduler.clear();
    this.current?.image.close();
    this.current = null;
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
      this.options.onResult?.(message);
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

  private render = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.render);

    const next = this.scheduler.take();
    if (next) {
      this.current?.image.close();
      this.current = next;
      this.dirty = true;
    }
    if (!this.dirty || !this.current) return;
    this.dirty = false;
    drawFrame(
      this.ctx,
      this.current.image,
      this.detections.at(this.current.pts),
      this.options.labelText,
      window.devicePixelRatio || 1,
    );
  };

  private resize(): void {
    const canvas = this.options.canvas;
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
