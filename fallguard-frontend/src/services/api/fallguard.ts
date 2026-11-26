import type {
  Alert,
  Camera,
  DetectionOverrides,
  DetectionRules,
  DetectionSettings,
  Gateway,
  GatewayLimits,
  GatewayConfig,
  GatewaysState,
  Health,
  Incident,
  IncidentStatus,
  LogEntry,
  Note,
  Notifications,
  Prediction,
  Stats,
} from "../../types/domain";
import { apiRequest, apiUrl, streamHubUrl } from "./client";
import type { LiveOverlay } from "../../store/uiStore";
import { appTimeZone } from "../../lib/format";

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

/** Query string from the set values only. */
function query(q: object): string {
  const p = new URLSearchParams();
  Object.entries(q).forEach(
    ([k, v]) =>
      v !== undefined && v !== null && v !== "" && p.set(k, String(v)),
  );
  return p.size ? "?" + p : "";
}

/** Filters shared by the incident list and the incident export. Times are ISO strings. */
export interface IncidentQuery {
  status?: string;
  severity?: string;
  camera_id?: string;
  zone?: string;
  alert_status?: string; // open | acknowledged | resolved | false_positive | none
  from?: string;
  to?: string;
  limit?: number;
}

export interface LogQuery {
  kind?: "" | "alert" | "incident" | "camera";
  camera_id?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** The app's time zone (Settings, else the browser's), so stats and exports match the page. */
const tz = appTimeZone;

export interface CameraInput {
  name: string;
  rtsp_url: string;
  username?: string;
  password?: string;
  location?: string;
  zone?: string;
  alert_offline?: boolean; // notify when it stops working (default on)
}

/** An account email (invitation, email check, password reset) and whether it went out. */
export interface AccountEmail {
  id: string;
  kind: string;
  recipient: string;
  subject: string;
  from_email: string;
  via: string;
  status: "sent" | "logged" | "failed" | string;
  error: string | null;
  created_at: string;
}

/** How a phone connects: Larix setup link (as a QR code) or the address for another app. */
export interface PhoneLinks {
  id: string;
  status?: string;
  name: string;
  publish_url: string;
  server_url: string;
  stream_key: string;
  setup_url: string;
  path: string;
  rtmp_server_url: string; // plain RTMP, for apps without RTMPS such as Streamza ("" = none)
  rtmp_publish_url: string;
}

/** Every call the frontend makes to the core backend (backend-module/api). */
export const api = {
  health: () => apiRequest<Health>("/health"),
  /** "Today" and the days are counted in the browser's time zone. */
  stats: () => apiRequest<Stats>("/stats?tz=" + enc(tz())),

  cameras: () =>
    apiRequest<{
      cameras: Camera[];
      gateway_error?: string;
      limits?: GatewayLimits;
      phone_cameras?: boolean; // phone cameras possible now (the cloud gateway is in use)
      gateway?: Gateway | null; // the gateway in use (null: none signed up yet)
    }>("/cameras"),
  /** Settings > Emails sent. */
  accountEmails: () =>
    apiRequest<{ emails: AccountEmail[]; server_from: string; kept_days: number }>("/org/emails"),
  /** The kept copy of an account email (its personal link taken out); "" for older emails. */
  accountEmailPreview: (id: string) => apiRequest<{ html: string }>("/org/emails/" + enc(id) + "/preview"),
  /** A phone that streams to the camera relay; the links (password inside) are shown once. */
  addPhoneCamera: (c: { name: string; location?: string; zone?: string }) =>
    apiRequest<PhoneLinks>("/cameras/phone", { method: "POST", ...json(c) }),
  /** New password and QR code for a phone camera (the old one stops working). */
  newPhoneLink: (id: string) =>
    apiRequest<PhoneLinks>("/cameras/" + enc(id) + "/phone-link", { method: "POST" }),
  /** status "paused" = saved on standby (the gateway is at its streaming limit). */
  addCamera: (c: CameraInput) =>
    apiRequest<{ id: string; status: string }>("/cameras", {
      method: "POST",
      ...json(c),
    }),
  /** Stream camera id instead of replaceId (pauses that one; resumes it again if id fails). */
  switchCamera: (id: string, replaceId: string) =>
    apiRequest("/cameras/" + enc(id) + "/switch", {
      method: "POST",
      ...json({ replace_id: replaceId }),
    }),
  /** Missing fields stay as they are. rtsp_url / username / password reconnect the camera
   *  (same camera: name, zone and history kept); an empty password keeps the current one. */
  updateCamera: (
    id: string,
    c: {
      name?: string;
      location?: string;
      zone?: string;
      alert_offline?: boolean;
      rtsp_url?: string;
      username?: string;
      password?: string;
    },
  ) => apiRequest("/cameras/" + enc(id), { method: "PATCH", ...json(c) }),
  /** Order shown in Live View and fall-event videos; first id first. */
  setCameraOrder: (ids: string[]) =>
    apiRequest("/cameras/order", {
      method: "PUT",
      ...json({ camera_ids: ids }),
    }),
  deleteCamera: (id: string) =>
    apiRequest("/cameras/" + enc(id), { method: "DELETE" }),
  pauseCamera: (id: string) =>
    apiRequest("/cameras/" + enc(id) + "/pause", { method: "POST" }),
  resumeCamera: (id: string) =>
    apiRequest("/cameras/" + enc(id) + "/resume", { method: "POST" }),

  incidents: (q: IncidentQuery = {}) =>
    apiRequest<{ incidents: Incident[] }>("/incidents" + query(q)),
  incident: (id: string) =>
    apiRequest<{
      incident: Incident;
      predictions: Prediction[];
      activity: LogEntry[];
    }>("/incidents/" + enc(id)),
  updateIncident: (
    id: string,
    body: { status?: IncidentStatus; notes?: string },
  ) => apiRequest("/incidents/" + enc(id), { method: "PATCH", ...json(body) }),
  addNote: (id: string, body: { author: string; text: string }) =>
    apiRequest<{ note: Note }>("/incidents/" + enc(id) + "/notes", {
      method: "POST",
      ...json(body),
    }),

  alerts: (status = "") =>
    apiRequest<{ alerts: Alert[] }>(
      "/alerts" + (status ? "?status=" + enc(status) : ""),
    ),
  /** reopen = undo Resolve or False alarm (back to open / acknowledged). */
  alertAction: (
    id: string,
    action: "acknowledge" | "resolve" | "false-positive" | "reopen",
  ) =>
    apiRequest<{ alert: Alert }>("/alerts/" + enc(id) + "/" + action, {
      method: "POST",
    }),

  notifications: () => apiRequest<Notifications>("/notifications"),
  logs: (q: LogQuery = {}) =>
    apiRequest<{ entries: LogEntry[] }>("/logs" + query(q)),

  /** Facility-wide settings: timezone null = each browser's own. */
  settings: () => apiRequest<{
    timezone: string | null; theme: "light" | "dark" | "system" | null;
    incident_overlay: Partial<LiveOverlay> | null; // default overlays on incident videos; null = built-in
  }>("/settings"),
  /** The organization's default overlays on incident videos (admins). */
  saveIncidentOverlay: (overlay: LiveOverlay) =>
    apiRequest<{ incident_overlay: LiveOverlay }>("/settings/incident-overlay", { method: "PUT", ...json(overlay) }),
  /** The organization's default theme (people who chose their own keep it). */
  saveDefaultTheme: (theme: "light" | "dark" | "system") =>
    apiRequest("/settings/theme", { method: "PUT", ...json({ theme }) }),
  saveSettings: (s: { timezone: string | null }) =>
    apiRequest("/settings", { method: "PUT", ...json(s) }),

  detection: () => apiRequest<DetectionSettings>("/detection"),
  /** Saves ALL detection overrides at once: a value left out goes back to config.yaml's.
   *  Use saveDetectionChange to change one or two and keep the rest. */
  saveDetection: (d: DetectionOverrides) =>
    apiRequest("/detection", { method: "PUT", ...json(d) }),
  /** Changes some overrides, keeping the other saved ones; null = back to config.yaml's. */
  saveDetectionChange: (saved: DetectionOverrides, change: { [K in keyof DetectionOverrides]?: DetectionOverrides[K] | null }) => {
    const next: Record<string, unknown> = { ...saved };
    for (const [k, v] of Object.entries(change)) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    return apiRequest("/detection", { method: "PUT", ...json(next) });
  },
  /** This organization's fall and alert rules: fields, defaults, its changes, can_edit (super admins). */
  detectionRules: () => apiRequest<DetectionRules>("/detection/rules"),
  /** Replaces the organization's rule changes; {} restores the defaults. */
  saveDetectionRules: (rules: Record<string, number>) =>
    apiRequest<{ saved: Record<string, number> }>("/detection/rules", { method: "PUT", ...json({ rules }) }),
  /** Settings → Gateways: every gateway, which answer, and the one in use. */
  gateways: () => apiRequest<GatewaysState>("/gateways"),
  /** The gateway to use; null = automatic (on-site if one is online, else cloud). */
  setGateway: (id: string | null) =>
    apiRequest<GatewaysState>("/gateways/active", { method: "PUT", ...json({ gateway_id: id }) }),
  updateGateway: (id: string, c: { name?: string; location?: string }) =>
    apiRequest<GatewaysState>("/gateways/" + enc(id), { method: "PATCH", ...json(c) }),
  /** Forget a gateway (not the one in use); removeCameras also removes its cameras. */
  deleteGateway: (id: string, removeCameras: boolean) =>
    apiRequest<{ ok: boolean; cameras_removed: number }>(
      "/gateways/" + enc(id) + (removeCameras ? "?remove_cameras=true" : ""), { method: "DELETE" }),
  /** A gateway's own connection settings (it must be online); saving re-registers it. */
  gatewayConfig: (id: string) => apiRequest<GatewayConfig>("/gateways/" + enc(id) + "/config"),
  saveGatewayConfig: (id: string, c: GatewayConfig) =>
    apiRequest("/gateways/" + enc(id) + "/config", { method: "PUT", ...json(c) }),
};

/** CSV downloads (open in Excel / Sheets); times in the browser's time zone. */
export const exportUrl = {
  incidents: (q: IncidentQuery) =>
    apiUrl(
      "/export/incidents.csv" + query({ ...q, limit: undefined, tz: tz() }),
    ),
  logs: (q: LogQuery) =>
    apiUrl("/export/logs.csv" + query({ ...q, limit: undefined, tz: tz() })),
};

/**
 * @deprecated MJPEG from the old annotated-video design; the live view now uses the
 * stream-hub WebSocket (features/live-view/live). Remove once nothing imports it.
 */
export const streamUrl = (cameraId: string) =>
  streamHubUrl("/cameras/" + enc(cameraId) + "/stream");

/** Incident video, stored by stream-hub; clip keys look like "clips/<incident>_<camera>.mp4". */
export const clipUrl = (key: string) =>
  streamHubUrl("/recordings/clips/" + enc(key.split("/").pop() ?? key));

/** Incident photo, stored by stream-hub; snapshot keys look like "snapshots/<id>.jpg". */
export const snapshotUrl = (key: string) =>
  streamHubUrl("/recordings/snapshots/" + enc(key.split("/").pop() ?? key));
