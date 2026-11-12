import type { LiveOverlay } from "../../../store/uiStore";
import type { DetectionsMessage } from "./protocol";

const LABEL_COLORS: Record<string, string> = {
  upright: "#22c55e",
  falling: "#f97316",
  lying: "#ef4444",
  unclear: "#9ca3af",
};
const DEFAULT_COLOR = "#22c55e";

/** COCO body-point pairs joined by the skeleton lines (0 nose, 5/6 shoulders, 11/12 hips...). */
const SKELETON: [number, number][] = [
  [15, 13], [13, 11], [16, 14], [14, 12], [11, 12], [5, 11], [6, 12], [5, 6],
  [5, 7], [6, 8], [7, 9], [8, 10], [1, 2], [0, 1], [0, 2], [1, 3], [2, 4],
];
/** Body points less sure than this are not drawn (the fall rules ignore them too). */
const MIN_POINT_CONF = 0.3;
const GRID_DIVISIONS = 8;

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

/** Dashed lines dividing the picture into GRID_DIVISIONS x GRID_DIVISIONS cells. */
function drawGrid(ctx: CanvasRenderingContext2D, area: Rect, pixelRatio: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = pixelRatio;
  ctx.setLineDash([4 * pixelRatio, 4 * pixelRatio]);
  ctx.beginPath();
  for (let i = 1; i < GRID_DIVISIONS; i++) {
    const x = area.x + (area.w * i) / GRID_DIVISIONS;
    const y = area.y + (area.h * i) / GRID_DIVISIONS;
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.h);
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.w, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Draws a frame filling the canvas (cropped like object-fit: cover) and the chosen overlays. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  image: ImageBitmap,
  detections: DetectionsMessage | null,
  labelText: (label: string) => string,
  pixelRatio: number,
  overlay: LiveOverlay,
): void {
  const { width, height } = ctx.canvas;
  const area = coverRect(image.width, image.height, width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, area.x, area.y, area.w, area.h);
  if (overlay.grid) drawGrid(ctx, area, pixelRatio);
  if (!detections) return;

  const fontPx = Math.round(12 * pixelRatio);
  const line = 2 * pixelRatio;
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "bottom";
  const px = (x: number) => area.x + x * area.w;
  const py = (y: number) => area.y + y * area.h;

  for (const person of detections.people) {
    const [x1, y1, x2, y2] = person.box;
    const x = px(x1);
    const y = py(y1);
    const w = (x2 - x1) * area.w;
    const h = (y2 - y1) * area.h;
    const color = LABEL_COLORS[person.label] ?? DEFAULT_COLOR;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = line;

    if (overlay.boxes) ctx.strokeRect(x, y, w, h);

    const points = person.keypoints;
    if (points && overlay.skeleton) {
      ctx.beginPath();
      for (const [a, b] of SKELETON) {
        const pa = points[a];
        const pb = points[b];
        if (!pa || !pb || pa[2] < MIN_POINT_CONF || pb[2] < MIN_POINT_CONF) continue;
        ctx.moveTo(px(pa[0]), py(pa[1]));
        ctx.lineTo(px(pb[0]), py(pb[1]));
      }
      ctx.stroke();
    }
    if (points && overlay.keypoints) {
      const r = 3 * pixelRatio;
      ctx.lineWidth = 1.5 * pixelRatio;
      ctx.fillStyle = "#ffffff";
      for (const [kx, ky, kc] of points) {
        if (kc < MIN_POINT_CONF) continue;
        ctx.beginPath();
        ctx.arc(px(kx), py(ky), r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.lineWidth = line;
      ctx.fillStyle = color;
    }
    if (overlay.center) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const r = 4 * pixelRatio;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath(); // crosshair, visible on any background
      ctx.moveTo(cx - 2 * r, cy);
      ctx.lineTo(cx + 2 * r, cy);
      ctx.moveTo(cx, cy - 2 * r);
      ctx.lineTo(cx, cy + 2 * r);
      ctx.stroke();
    }

    const parts = [
      overlay.track ? `#${person.track}` : "",
      overlay.label ? labelText(person.label) : "",
      overlay.confidence ? `${Math.round(person.confidence * 100)}%` : "",
    ].filter(Boolean);
    if (parts.length === 0) continue;
    const text = parts.join(" ");
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
