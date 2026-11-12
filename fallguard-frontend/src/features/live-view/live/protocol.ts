/**
 * Messages of the stream-hub camera WebSocket (`/ws/:tenant/:camera?v=2`).
 *
 * Binary: one H.264 NALU in Annex B, prefixed with its picture's PTS:
 *   [8 bytes big-endian int64: PTS, Unix epoch ms][NALU]
 * Every NALU of one picture carries the same PTS.
 *
 * Text: JSON results from the ml-service (detections and incident events).
 */

export interface DetectedPerson {
  track: number;
  label: string; // "upright" | "falling" | "lying" | "unclear"
  confidence: number;
  /** [x1, y1, x2, y2] normalised to 0..1 of the frame. */
  box: [number, number, number, number];
  incident_id: string | null;
  /** The 17 COCO body points as [x, y, confidence], x and y normalised to 0..1 (newer ml-service). */
  keypoints?: [number, number, number][];
}

/** Sent for every analysed frame (~10 fps), also when nobody is in view. */
export interface DetectionsMessage {
  type: "detections";
  camera_id: string;
  pts: number;
  width: number;
  height: number;
  people: DetectedPerson[];
}

export interface IncidentMessage {
  type: "incident";
  camera_id: string;
  pts: number | null;
  event: string; // incident_started | incident_updated | incident_recovered | incident_unresolved
  incident_id: string | null;
  severity: string;
  zone: string;
  cameras: string[];
}

export type ResultMessage = DetectionsMessage | IncidentMessage;

export interface VideoChunk {
  pts: number;
  nalu: Uint8Array;
}

const PTS_BYTES = 8;

export function parseVideoMessage(data: ArrayBuffer): VideoChunk | null {
  if (data.byteLength <= PTS_BYTES) return null;
  const pts = Number(new DataView(data).getBigInt64(0));
  return { pts, nalu: new Uint8Array(data, PTS_BYTES) };
}

export function parseResultMessage(text: string): ResultMessage | null {
  try {
    const msg = JSON.parse(text);
    return msg?.type === "detections" || msg?.type === "incident"
      ? (msg as ResultMessage)
      : null;
  } catch {
    return null;
  }
}
