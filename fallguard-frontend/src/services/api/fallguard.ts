import type {
  Alert, Camera, DetectionSettings, GatewayConfig, Health, Incident, IncidentStatus, LogEntry, Notifications,
  Prediction, Stats,
} from '../../types/domain';
import { apiRequest, apiUrl } from './client';

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

/** The browser's time zone, so exported times match what the page shows. */
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

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
  stats: () => apiRequest<Stats>('/stats'),

  cameras: () => apiRequest<{ cameras: Camera[]; gateway_error?: string }>('/cameras'),
  addCamera: (c: CameraInput) => apiRequest<{ id: string }>('/cameras', { method: 'POST', ...json(c) }),
  updateCamera: (id: string, c: { name?: string; location?: string; zone?: string; alert_offline?: boolean }) =>
    apiRequest('/cameras/' + enc(id), { method: 'PATCH', ...json(c) }),
  deleteCamera: (id: string) => apiRequest('/cameras/' + enc(id), { method: 'DELETE' }),
  pauseCamera: (id: string) => apiRequest('/cameras/' + enc(id) + '/pause', { method: 'POST' }),
  resumeCamera: (id: string) => apiRequest('/cameras/' + enc(id) + '/resume', { method: 'POST' }),

  incidents: (q: IncidentQuery = {}) => apiRequest<{ incidents: Incident[] }>('/incidents' + query(q)),
  incident: (id: string) =>
    apiRequest<{ incident: Incident; predictions: Prediction[]; activity: LogEntry[] }>('/incidents/' + enc(id)),
  updateIncident: (id: string, body: { status?: IncidentStatus; notes?: string }) =>
    apiRequest('/incidents/' + enc(id), { method: 'PATCH', ...json(body) }),

  alerts: (status = '') => apiRequest<{ alerts: Alert[] }>('/alerts' + (status ? '?status=' + enc(status) : '')),
  alertAction: (id: string, action: 'acknowledge' | 'resolve' | 'false-positive') =>
    apiRequest<{ alert: Alert }>('/alerts/' + enc(id) + '/' + action, { method: 'POST' }),

  notifications: () => apiRequest<Notifications>('/notifications'),
  logs: (q: LogQuery = {}) => apiRequest<{ entries: LogEntry[] }>('/logs' + query(q)),

  detection: () => apiRequest<DetectionSettings>('/detection'),
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

/** Incident photo; snapshot keys look like "snapshots/<id>.jpg". */
export const snapshotUrl = (key: string) => apiUrl('/snapshots/' + enc(key.split('/').pop() ?? key));
