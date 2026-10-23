import type {
  Alert, Camera, DetectionSettings, GatewayConfig, Health, Incident, IncidentStatus, Prediction, Stats,
} from '../../types/domain';
import { apiRequest, apiUrl } from './client';

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

export interface CameraInput {
  name: string;
  rtsp_url: string;
  username?: string;
  password?: string;
  location?: string;
  zone?: string;
}

/** Every call the frontend makes to the core backend (backend-module/api). */
export const api = {
  health: () => apiRequest<Health>('/health'),
  stats: () => apiRequest<Stats>('/stats'),

  cameras: () => apiRequest<{ cameras: Camera[]; gateway_error?: string }>('/cameras'),
  addCamera: (c: CameraInput) => apiRequest<{ id: string }>('/cameras', { method: 'POST', ...json(c) }),
  updateCamera: (id: string, c: { name?: string; location?: string; zone?: string }) =>
    apiRequest('/cameras/' + enc(id), { method: 'PATCH', ...json(c) }),
  deleteCamera: (id: string) => apiRequest('/cameras/' + enc(id), { method: 'DELETE' }),
  pauseCamera: (id: string) => apiRequest('/cameras/' + enc(id) + '/pause', { method: 'POST' }),
  resumeCamera: (id: string) => apiRequest('/cameras/' + enc(id) + '/resume', { method: 'POST' }),

  incidents: (q: { status?: string; camera_id?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => v !== undefined && v !== '' && p.set(k, String(v)));
    return apiRequest<{ incidents: Incident[] }>('/incidents' + (p.size ? '?' + p : ''));
  },
  incident: (id: string) => apiRequest<{ incident: Incident; predictions: Prediction[] }>('/incidents/' + enc(id)),
  updateIncident: (id: string, body: { status?: IncidentStatus; notes?: string }) =>
    apiRequest('/incidents/' + enc(id), { method: 'PATCH', ...json(body) }),

  alerts: (status = '') => apiRequest<{ alerts: Alert[] }>('/alerts' + (status ? '?status=' + enc(status) : '')),
  alertAction: (id: string, action: 'acknowledge' | 'resolve' | 'false-positive') =>
    apiRequest<{ alert: Alert }>('/alerts/' + enc(id) + '/' + action, { method: 'POST' }),

  detection: () => apiRequest<DetectionSettings>('/detection'),
  gatewayConfig: () => apiRequest<GatewayConfig>('/gateway/config'),
  saveGatewayConfig: (c: GatewayConfig) => apiRequest('/gateway/config', { method: 'PUT', ...json(c) }),
};

/** MJPEG live video (annotated by ml-service). */
export const streamUrl = (cameraId: string) => apiUrl('/cameras/' + enc(cameraId) + '/stream');

/** Incident photo; snapshot keys look like "snapshots/<id>.jpg". */
export const snapshotUrl = (key: string) => apiUrl('/snapshots/' + enc(key.split('/').pop() ?? key));
