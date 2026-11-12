import type { VideoChunk } from "./protocol";

const NAL_IDR = 5;
const NAL_SPS = 7;

function headerIndex(nalu: Uint8Array): number {
  if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 0 && nalu[3] === 1)
    return 4;
  if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 1) return 3;
  return 0;
}

/** NAL unit type of an H.264 NALU, with or without an Annex B start code. */
export function nalType(nalu: Uint8Array): number {
  const i = headerIndex(nalu);
  return i < nalu.length ? nalu[i] & 0x1f : -1;
}

/** A picture's slices (types 1-5), as opposed to parameter sets, SEI, etc. */
function isVcl(type: number): boolean {
  return type >= 1 && type <= 5;
}

/** WebCodecs codec string ("avc1.PPCCLL": profile, constraints, level) from an SPS. */
export function codecFromSps(sps: Uint8Array): string {
  const i = headerIndex(sps);
  const hex = (b: number) => b.toString(16).padStart(2, "0");
  return `avc1.${hex(sps[i + 1])}${hex(sps[i + 2])}${hex(sps[i + 3])}`;
}

/** One picture, ready for the decoder: its NALUs concatenated in Annex B. */
export interface AccessUnit {
  pts: number;
  data: Uint8Array;
  key: boolean;
  sps: Uint8Array | null;
}

/**
 * Groups NALUs into pictures. stream-hub gives every NALU of one picture the same PTS,
 * so a picture is complete when a NALU with a new PTS arrives (one frame of latency).
 *
 * Parameter sets that arrive on their own, without a picture, are kept and put in front
 * of the next picture, so a keyframe always reaches the decoder with its SPS/PPS.
 */
export class AccessUnitAssembler {
  private nalus: Uint8Array[] = [];
  private pts: number | null = null;
  private carried: Uint8Array[] = [];

  push(chunk: VideoChunk): AccessUnit | null {
    let complete: AccessUnit | null = null;
    if (this.pts !== null && chunk.pts !== this.pts)
      complete = this.flush(this.pts);
    this.nalus.push(chunk.nalu);
    this.pts = chunk.pts;
    return complete;
  }

  reset(): void {
    this.nalus = [];
    this.carried = [];
    this.pts = null;
  }

  private flush(pts: number): AccessUnit | null {
    const nalus = [...this.carried, ...this.nalus];
    this.nalus = [];
    const types = nalus.map(nalType);
    if (!types.some(isVcl)) {
      this.carried = nalus; // parameter sets only: wait for the picture
      return null;
    }
    this.carried = [];
    const spsIndex = types.lastIndexOf(NAL_SPS);
    return {
      pts,
      data: concat(nalus),
      key: types.includes(NAL_IDR),
      sps: spsIndex >= 0 ? nalus[spsIndex] : null,
    };
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
