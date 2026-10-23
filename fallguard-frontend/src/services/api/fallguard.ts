import type {
  Alert, Camera, DetectionSettings, GatewayLimits, GatewayConfig, Health, Incident, IncidentStatus, LogEntry, Note, Notifications,
  Prediction, Stats,
} from '../../types/domain';
import { apiRequest, apiUrl } from './client';
import { appTimeZone } from '../../lib/format';

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

/** Query string from the set values only. */
function query(q: object): string {
  const p = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => v !== undefined && v !== null && v !== '' && p.set(k, String(v)));
  return p.size ? '?' + p : '';
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
  kind?: '' | 'alert' | 'incident' | 'camera';
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

/** Every call the frontend makes to the core backend (backend-module/api). */
export const api = {
  health: () => apiRequest<Health>('/health'),
  /** "Today" and the days are counted in the browser's time zone. */
  stats: () => apiRequest<Stats>('/stats?tz=' + enc(tz())),

  cameras: () => apiRequest<{ cameras: Camera[]; gateway_error?: string; limits?: GatewayLimits }>('/cameras'),
  /** status "paused" = saved on standby (the gateway is at its streaming limit). */
  addCamera: (c: CameraInput) => apiRequest<{ id: string; status: string }>('/cameras', { method: 'POST', ...json(c) }),
  /** Stream camera id instead of replaceId (pauses that one; resumes it again if id fails). */
  switchCamera: (id: string, replaceId: string) =>
    apiRequest('/cameras/' + enc(id) + '/switch', { method: 'POST', ...json({ replace_id: replaceId }) }),
  updateCamera: (id: string, c: { name?: string; location?: string; zone?: string; alert_offline?: boolean }) =>
    apiRequest('/cameras/' + enc(id), { method: 'PATCH', ...json(c) }),
  /** Order shown in Live View and fall-event videos; first id first. */
  setCameraOrder: (ids: string[]) => apiRequest('/cameras/order', { method: 'PUT', ...json({ camera_ids: ids }) }),
  deleteCamera: (id: string) => apiRequest('/cameras/' + enc(id), { method: 'DELETE' }),
  pauseCamera: (id: string) => apiRequest('/cameras/' + enc(id) + '/pause', { method: 'POST' }),
  resumeCamera: (id: string) => apiRequest('/cameras/' + enc(id) + '/resume', { method: 'POST' }),

  incidents: (q: IncidentQuery = {}) => apiRequest<{ incidents: Incident[] }>('/incidents' + query(q)),
  incident: (id: string) =>
    apiRequest<{ incident: Incident; predictions: Prediction[]; activity: LogEntry[] }>('/incidents/' + enc(id)),
  updateIncident: (id: string, body: { status?: IncidentStatus; notes?: string }) =>
    apiRequest('/incidents/' + enc(id), { method: 'PATCH', ...json(body) }),
  addNote: (id: string, body: { author: string; text: string }) =>
    apiRequest<{ note: Note }>('/incidents/' + enc(id) + '/notes', { method: 'POST', ...json(body) }),

  alerts: (status = '') => apiRequest<{ alerts: Alert[] }>('/alerts' + (status ? '?status=' + enc(status) : '')),
  alertAction: (id: string, action: 'acknowledge' | 'resolve' | 'false-positive') =>
    apiRequest<{ alert: Alert }>('/alerts/' + enc(id) + '/' + action, { method: 'POST' }),

  notifications: () => apiRequest<Notifications>('/notifications'),
  logs: (q: LogQuery = {}) => apiRequest<{ entries: LogEntry[] }>('/logs' + query(q)),

  /** Facility-wide settings: timezone null = each browser's own. */
  settings: () => apiRequest<{ timezone: string | null }>('/settings'),
  saveSettings: (s: { timezone: string | null }) => apiRequest('/settings', { method: 'PUT', ...json(s) }),

  detection: () => apiRequest<DetectionSettings>('/detection'),
  /** person_confidence null = back to config.yaml's value. */
  saveDetection: (d: { person_confidence: number | null }) =>
    apiRequest('/detection', { method: 'PUT', ...json(d.person_confidence === null ? {} : d) }),
  gatewayConfig: () => apiRequest<GatewayConfig>('/gateway/config'),
  saveGatewayConfig: (c: GatewayConfig) => apiRequest('/gateway/config', { method: 'PUT', ...json(c) }),
};

/** CSV downloads (open in Excel / Sheets); times in the browser's time zone. */
export const exportUrl = {
  incidents: (q: IncidentQuery) => apiUrl('/export/incidents.csv' + query({ ...q, limit: undefined, tz: tz() })),
  logs: (q: LogQuery) => apiUrl('/export/logs.csv' + query({ ...q, limit: undefined, tz: tz() })),
};

/** MJPEG live video (annotated by ml-service). */
export const streamUrl = (cameraId: string) => apiUrl('/cameras/' + enc(cameraId) + '/stream');

/** Incident video; clip keys look like "clips/<incident>_<camera>.mp4". */
export const clipUrl = (key: string) => apiUrl('/clips/' + enc(key.split('/').pop() ?? key));

/** Incident photo; snapshot keys look like "snapshots/<id>.jpg". */
export const snapshotUrl = (key: string) => apiUrl('/snapshots/' + enc(key.split('/').pop() ?? key));
