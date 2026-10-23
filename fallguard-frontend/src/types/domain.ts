/**
 * Domain types: the JSON shapes returned by the core backend API (backend-module/api).
 */
export type CameraStatus = 'online' | 'paused' | 'not_on_gateway' | 'offline' | string;

/** What a camera is doing right now (kept by the backend's camera monitor). */
export type CameraHealth = 'online' | 'paused' | 'not_working' | 'connecting' | 'not_connected';

export interface LivePerson {
  track: number;
  label: 'upright' | 'falling' | 'lying' | string;
  confidence: number;
}

export interface Camera {
  id: string;
  name: string;
  location: string | null;
  zone: string | null;
  status: CameraStatus; // as the gateway reports it
  health: CameraHealth;
  health_since: string | null;
  alert_offline: boolean; // notify when it stops working
  on_gateway: boolean;
  rtsp_url: string; // without credentials
  created_at: string;
  live: boolean; // ml-service is receiving its video
  people: LivePerson[];
  last_frame_age_s: number | null;
  active_incidents: number;
}

export type IncidentStatus = 'active' | 'recovered' | 'unresolved' | 'false_positive';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface IncidentCamera {
  camera_id: string;
  camera_name: string | null;
  track_id: number;
  joined_at: string;
  snapshot_key: string | null;
}

export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'false_positive';

export interface Alert {
  id: string;
  incident_id: string | null;
  camera_id: string;
  camera_name: string | null;
  triggered_at: string;
  severity: Severity;
  status: AlertStatus;
  summary: string | null;
  snapshot_key: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  closed_at: string | null; // resolved or marked a false alarm
  closed_by: string | null;
}

export interface Incident {
  id: string;
  camera_id: string;
  camera_name: string | null;
  zone: string | null;
  started_at: string;
  recovered_at: string | null;
  duration_seconds: number | null;
  status: IncidentStatus;
  severity: Severity;
  peak_confidence: number | null;
  location_label: string | null;
  snapshot_key: string | null;
  notes: string | null;
  cameras: IncidentCamera[];
  alert: Alert | null;
}

export interface Prediction {
  at: string;
  camera_id: string;
  label: string;
  confidence: number;
  output: { torso_angle_deg?: number | null; aspect_ratio?: number; track_id?: number } | null;
}

export interface Stats {
  active_incidents: number;
  open_alerts: number;
  incidents_today: number;
  incidents_7d: number;
  avg_down_seconds_7d: number | null;
  false_positives_7d: number;
  per_day: { day: string; count: number }[];
  per_camera: { camera_id: string; camera_name: string | null; count: number }[];
  by_severity: Record<string, number>;
  by_status: Record<string, number>;
  predictions_last_hour: Record<string, number>;
}

/** One line of the activity log: a user action, or a camera change the system noticed. */
export interface LogEntry {
  at: string;
  kind: 'alert' | 'incident' | 'camera';
  action: string; // e.g. alert.acknowledged, camera.paused, camera.not_working
  actor: string | null; // null: noticed by the system
  camera_id: string | null;
  camera_name: string | null;
  target_id: string | null;
  incident_id: string | null;
  message: string;
}

/** A camera row from the database, as the notifications list returns it. */
export interface DownCamera {
  id: string;
  name: string;
  location: string | null;
  zone: string | null;
  status_since: string | null;
}

export interface Notifications {
  alerts: Alert[];
  cameras: DownCamera[]; // stopped working, with alerts on
}

export interface ServiceCheck {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

export interface Health {
  ok: boolean;
  tenant: string;
  services: Record<string, ServiceCheck>;
}

export interface DetectionSettings {
  mode: string;
  model: string;
  device: string;
  target_fps: number;
  person_confidence: number;
  rules: Record<string, number>;
  incidents: Record<string, number>;
  zones: Record<string, string[]>;
}

export interface GatewayConfig {
  cloud_address: string;
  server_port: string;
  tenant_id: string;
}
