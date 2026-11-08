import type { DetectionsMessage } from "./protocol";

/**
 * Recent detections of one camera, looked up by the PTS of the frame being drawn.
 *
 * The ml-service analyses about 10 of the camera's ~30 frames per second, so a frame
 * uses the newest detection at or before its PTS. Detections older than maxAgeMs are
 * ignored, so boxes disappear when the ml-service stops sending.
 */
export class DetectionBuffer {
  private items: DetectionsMessage[] = [];
  private readonly maxAgeMs: number;
  private readonly maxItems: number;

  constructor(maxAgeMs = 1000, maxItems = 100) {
    this.maxAgeMs = maxAgeMs;
    this.maxItems = maxItems;
  }

  add(detections: DetectionsMessage): void {
    const last = this.items[this.items.length - 1];
    this.items.push(detections);
    if (last && detections.pts < last.pts)
      this.items.sort((a, b) => a.pts - b.pts);
    if (this.items.length > this.maxItems) this.items.shift();
  }

  at(pts: number): DetectionsMessage | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const d = this.items[i];
      if (d.pts <= pts) return pts - d.pts <= this.maxAgeMs ? d : null;
    }
    return null;
  }

  clear(): void {
    this.items = [];
  }
}
