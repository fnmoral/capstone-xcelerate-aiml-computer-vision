/**
 * Draft domain types for Module 1. Field names are provisional until the
 * Core Backend (Module 2) API contract is agreed. [TEAM CONFIRMATION REQUIRED]
 */
export type CameraStatus = 'online' | 'offline' | 'connecting';

export interface Camera {
  id: string;
  name: string;
  location: string;
  streamUrl: string; // browser-playable URL served by the Streaming Module, not the raw RTSP address
  status: CameraStatus;
}

export interface FallEvent {
  id: string;
  cameraId: string;
  detectedAt: string; // ISO 8601
  status: 'open' | 'acknowledged' | 'resolved';
  severity?: string; // severity classification is PROPOSED, not validated
}
