/**
 * Domain types: the JSON shapes returned by the core backend API (backend-module/api).
 */
export type CameraStatus =
  | "online"
  | "paused"
  | "not_on_gateway"
  | "offline"
  | string;

/** What a camera is doing right now (kept by the backend's camera monitor). */
export type CameraHealth =
  | "online"
  | "paused"
  | "not_working"
  | "connecting"
  | "not_connected";

/** A gateway's camera limits: how many stream at once, how many can be saved (the rest paused). */
export interface GatewayLimits {
  max_streaming: number;
  max_saved: number;
}

export interface LivePerson {
  track: number;
  label: "upright" | "falling" | "lying" | string;
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
  tenant_id: string; // without credentials
}

export type IncidentStatus =
  | "active"
  | "recovered"
  | "unresolved"
  | "false_positive";
export type Severity = "low" | "medium" | "high" | "critical";

export interface IncidentCamera {
  camera_id: string;
  camera_name: string | null;
  track_id: number;
  joined_at: string;
  snapshot_key: string | null;
  clip_key?: string | null; // this camera's video of the incident, once saved
}

export type AlertStatus =
  | "open"
  | "acknowledged"
  | "resolved"
  | "false_positive";

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
  clip_key: string | null; // main camera's video (clips/<incident>_<camera>.mp4)
  notes: string | null; // the single note field used before; also first in note_list
  note_list: Note[]; // every note, oldest first
  cameras: IncidentCamera[];
  alert: Alert | null;
}

/** One note on an incident. Several people can add notes; none is overwritten. */
export interface Note {
  at: string;
  author: string;
  text: string;
}

export interface Prediction {
  at: string;
  camera_id: string;
  label: string;
  confidence: number;
  output: {
    torso_angle_deg?: number | null;
    aspect_ratio?: number;
    track_id?: number;
  } | null;
}

export interface Stats {
  active_incidents: number;
  open_alerts: number;
  incidents_today: number;
  incidents_7d: number;
  avg_down_seconds_7d: number | null;
  false_positives_7d: number;
  per_day: { day: string; count: number }[];
  per_camera: {
    camera_id: string;
    camera_name: string | null;
    count: number;
  }[];
  by_severity: Record<string, number>;
  by_status: Record<string, number>;
  predictions_last_hour: Record<string, number>;
}

/** One line of the activity log: a user action, or a camera change the system noticed. */
export interface LogEntry {
  at: string;
  kind: "alert" | "incident" | "camera" | "settings";
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
  device: string; // as configured: auto, a GPU number, or cpu
  device_in_use: string | null; // what it resolved to, e.g. "GPU 0 (NVIDIA GeForce RTX 3060 Laptop GPU)" or "CPU"
  target_fps: number;
  analysis: {
    // measured over the last 30 s
    average_fps: number | null; // frames analysed per second, averaged over cameras receiving video
    cameras: {
      camera_id: string;
      received_fps: number;
      analysed_fps: number;
    }[];
  };
  person_confidence: number; // in use now
  person_confidence_default: number; // config.yaml
  saved: { person_confidence?: number }; // set in this app; ml-service applies it within 15 s
  clips: {
    enabled: boolean;
    pre_roll_s: number;
    post_roll_s: number;
    max_s: number;
    max_width: number;
    retention_days: number;
    max_total_gb: number;
  };
  rules: Record<string, number>;
  incidents: Record<string, number>;
  zones: Record<string, string[]>;
}

export interface GatewayConfig {
  cloud_address: string;
  server_port: string;
  tenant_id: string;
}
