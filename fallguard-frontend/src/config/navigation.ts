import type { ComponentType } from 'react';

export type NavSection = 'monitor' | 'manage' | 'system';

export interface NavItem {
  path: string;
  label: string;
  icon: string; // key into components/ui/Icon
  section: NavSection;
  /** Shown to roles with at least one of these permissions (see features/auth PERM). */
  perm: string[];
  load: () => Promise<{ default: ComponentType }>;
}

/**
 * Single source of truth for the app's pages.
 * Sections follow the UI areas described in the Project Vision Document.
 */
export const NAV_ITEMS: NavItem[] = [
  { path: '/live', label: 'Live View', icon: 'video', section: 'monitor', perm: ['live.view'], load: () => import('../features/live-view/LiveViewPage') },
  { path: '/events', label: 'Fall Events', icon: 'alert', section: 'monitor', perm: ['events.view'], load: () => import('../features/events/EventsPage') },
  { path: '/analytics', label: 'Analytics', icon: 'chart', section: 'monitor', perm: ['analytics.view'], load: () => import('../features/analytics/AnalyticsPage') },
  { path: '/reports', label: 'Reports & Export', icon: 'download', section: 'monitor', perm: ['reports.view', 'incident_reports.manage'], load: () => import('../features/reports/ReportsPage') },
  { path: '/cameras', label: 'Cameras', icon: 'camera', section: 'manage', perm: ['cameras.manage', 'live.view'], load: () => import('../features/cameras/CamerasPage') },
  { path: '/camera-logs', label: 'Camera Logs', icon: 'log', section: 'manage', perm: ['logs.view'], load: () => import('../features/camera-logs/CameraLogsPage') },
  { path: '/detection', label: 'Detection Settings', icon: 'sliders', section: 'manage', perm: ['detection.manage', 'live.view'], load: () => import('../features/detection/DetectionPage') },
  { path: '/notifications', label: 'Notifications', icon: 'bell', section: 'manage', perm: ['notifications.manage'], load: () => import('../features/notifications/NotificationsPage') },
  { path: '/members', label: 'Members & Roles', icon: 'users', section: 'system', perm: ['members.view'], load: () => import('../features/members/MembersPage') },
  { path: '/settings', label: 'Settings', icon: 'gear', section: 'system', perm: [], load: () => import('../features/settings/SettingsPage') },
];

export const SECTION_LABELS: Record<NavSection, string> = {
  monitor: 'Monitor',
  manage: 'Manage',
  system: 'System',
};

/** First page a role can open (where "/" and sign-in lead). */
export function homePath(can: (p: string) => boolean): string {
  return NAV_ITEMS.find((i) => i.perm.length === 0 || i.perm.some(can))?.path ?? '/settings';
}
