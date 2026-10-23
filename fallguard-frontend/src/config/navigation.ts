import type { ComponentType } from 'react';

export type NavSection = 'monitor' | 'manage' | 'system';

export interface NavItem {
  path: string;
  label: string;
  icon: string; // key into components/ui/Icon
  section: NavSection;
  load: () => Promise<{ default: ComponentType }>;
}

/**
 * Single source of truth for the app's pages.
 * Sections follow the UI areas described in the Project Vision Document.
 */
export const NAV_ITEMS: NavItem[] = [
  { path: '/live', label: 'Live View', icon: 'video', section: 'monitor', load: () => import('../features/live-view/LiveViewPage') },
  { path: '/events', label: 'Fall Events', icon: 'alert', section: 'monitor', load: () => import('../features/events/EventsPage') },
  { path: '/analytics', label: 'Analytics', icon: 'chart', section: 'monitor', load: () => import('../features/analytics/AnalyticsPage') },
  { path: '/reports', label: 'Reports & Export', icon: 'download', section: 'monitor', load: () => import('../features/reports/ReportsPage') },
  { path: '/cameras', label: 'Cameras', icon: 'camera', section: 'manage', load: () => import('../features/cameras/CamerasPage') },
  { path: '/camera-logs', label: 'Camera Logs', icon: 'log', section: 'manage', load: () => import('../features/camera-logs/CameraLogsPage') },
  { path: '/detection', label: 'Detection Settings', icon: 'sliders', section: 'manage', load: () => import('../features/detection/DetectionPage') },
  { path: '/settings', label: 'Settings', icon: 'gear', section: 'system', load: () => import('../features/settings/SettingsPage') },
];

export const SECTION_LABELS: Record<NavSection, string> = {
  monitor: 'Monitor',
  manage: 'Manage',
  system: 'System',
};
