import type { DetectionsMessage } from "./protocol";

const LABEL_COLORS: Record<string, string> = {
  upright: "#22c55e",
  falling: "#f97316",
  lying: "#ef4444",
};
const DEFAULT_COLOR = "#22c55e";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a srcW x srcH image lands when it covers dstW x dstH (CSS object-fit: cover). */
export function coverRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Rect {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
}

/** Draws a frame filling the canvas (cropped like object-fit: cover) and its detections. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  image: ImageBitmap,
  detections: DetectionsMessage | null,
  labelText: (label: string) => string,
  pixelRatio: number,
): void {
  const { width, height } = ctx.canvas;
  const area = coverRect(image.width, image.height, width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, area.x, area.y, area.w, area.h);
  if (!detections) return;

  const fontPx = Math.round(12 * pixelRatio);
  ctx.lineWidth = 2 * pixelRatio;
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "bottom";

  for (const person of detections.people) {
    const [x1, y1, x2, y2] = person.box;
    const x = area.x + x1 * area.w;
    const y = area.y + y1 * area.h;
    const w = (x2 - x1) * area.w;
    const h = (y2 - y1) * area.h;
    const color = LABEL_COLORS[person.label] ?? DEFAULT_COLOR;

    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);

    const text = `#${person.track} ${labelText(person.label)} ${Math.round(person.confidence * 100)}%`;
    const pad = 4 * pixelRatio;
    const textW = ctx.measureText(text).width + pad * 2;
    const textH = fontPx + pad;
    const labelY = Math.max(y, textH); // keep the label inside the canvas
    ctx.fillStyle = color;
    ctx.fillRect(x, labelY - textH, textW, textH);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x + pad, labelY - pad / 2);
  }
}
