import { apiRequest } from "./client";
import type { Incident, LogEntry } from "../../types/domain";

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : json(body)) });

// ---------- types ----------

export type Role = "admin" | "member" | "viewer";

export interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email_verified: boolean;
  last_login_at: string | null;
  created_at: string;
  /** Demo visitor through a demo access link: view-only until access_until. */
  is_guest?: boolean;
  access_until?: string | null;
}

export interface GuestLink {
  id: string;
  label: string;
  expires_at: string;
  revoked_at: string | null;
  visits: number;
  last_visit_at: string | null;
  created_by: string | null;
  created_at: string;
  status: "active" | "expired" | "revoked";
}

export interface OrgRef {
  id: string;
  name: string;
  role: Role;
}

export interface Me {
  user: User;
  org: { id: string; name: string; has_gateway: boolean };
  role: Role;
  permissions: string[];
  orgs: OrgRef[];
}

/** Answer after an email was sent. dev_link only when the server shows links (no mail server, demos). */
export interface Mailed {
  ok: boolean;
  email_delivery?: "sent" | "logged";
  dev_link?: string;
}

export interface Member extends User {
  role: Role;
  joined_at: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  invited_by: string | null;
  expires_at: string;
  created_at: string;
  status: "pending" | "expired" | "accepted" | "revoked";
}

export interface Permission {
  key: string;
  group: string;
  label: string;
  description: string;
  admin_only: boolean;
}

export interface RolePermissions {
  catalog: Permission[];
  roles: Record<Role, string[]>;
  defaults: Record<"member" | "viewer", string[]>;
}

export interface InvitationInfo {
  email: string;
  role: Role;
  org_name: string;
  invited_by: string;
  account_exists: boolean;
}

export interface OrgProfile {
  name: string;
  slug: string;
  legal_name: string;
  address: string;
  city: string;
  province: string;
  postal_code: string;
  country: string;
  phone: string;
  wsib_firm_number: string;
  wsib_rate_group: string;
  business_type: string;
  establishment: string;
  /** Days a deleted incident report can be restored (default 14). */
  report_retention_days: number;
}

// ---- notifications ----

export type NotifySeverity = "medium" | "high" | "critical";
export type NotifyChannel = "app" | "email" | "sms";
export type NotifyEvent = "alert" | "recovered" | "false_alarm" | "resolved";

export interface Recipient {
  name: string;
  address: string;
  user_id?: string | null;
  severities: NotifySeverity[];
  enabled: boolean;
}

export interface Template {
  custom: boolean;
  subject: string;
  body: string;
  sms: string;
}

export interface NotifyConfig {
  matrix: Record<NotifyChannel, Record<NotifySeverity, boolean>>;
  email_recipients: Recipient[];
  sms_recipients: Recipient[];
  follow_ups: Record<"recovered" | "false_alarm" | "resolved", boolean>;
  templates: Record<NotifyEvent, Template>;
  app_url: string;
}

export interface EmailProvider {
  type: "log" | "server" | "smtp"; // off | FallGuard's own email | the organization's server
  host: string;
  port: number;
  security: "starttls" | "tls" | "none" | "";
  username: string;
  from_email: string;
  from_name: string;
  password_set?: boolean;
  password?: string;
}

export interface SMSProvider {
  type: "log" | "twilio";
  account_sid: string;
  from_number: string;
  auth_token_set?: boolean;
  auth_token?: string;
}

export interface NotificationSettings {
  config: NotifyConfig;
  email_provider: EmailProvider;
  sms_provider: SMSProvider;
  default_templates: Record<NotifyEvent, Template>;
  placeholders: Record<string, string>;
  members: { user_id: string; name: string; email: string; phone: string | null; role: Role }[];
  system_smtp: boolean;
  server_from: string; // FallGuard's own sender ("" = none on this server)
}

export interface Delivery {
  id: string;
  alert_id: string | null;
  event: string;
  channel: "email" | "sms";
  recipient: string;
  subject: string | null;
  status: "pending" | "sent" | "logged" | "failed";
  attempts: number;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

// ---- incident reports ----

export type ReportForm = "wsib_form7" | "ohsa_notice" | "osha_301" | "internal";

export interface IncidentReport {
  id: string;
  incident_id: string;
  form: ReportForm;
  status: "draft" | "final";
  title: string;
  content: ReportContent;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  finalized_by: string | null;
  finalized_at: string | null;
  camera_name?: string | null;
  incident_started_at?: string | null;
  /** Recently deleted reports only: when, by whom, and when it is removed for good. */
  deleted_at?: string;
  deleted_by?: string | null;
  purge_at?: string;
}

/** Field values of a report; auto lists fields filled from FallGuard records, from the fields
 *  copied from an earlier report (field key -> where from, e.g. "WSIB Form 7"). */
export interface ReportContent {
  fields?: Record<string, string>;
  auto?: string[];
  from?: Record<string, string>;
  facts_at?: string;
}

export interface ReportFacts {
  incident: Incident;
  cameras: { id: string; name: string | null; location: string | null; zone: string | null; snapshot_key: string | null; clip_key: string | null }[];
  activity: LogEntry[];
  prediction_count: number;
  model: string | null;
  org: OrgProfile;
  timezone: string | null;
  prepared_by: { name: string; email: string; phone: string | null; role: Role };
  generated_at: string;
  app_url: string;
}

// ---------- calls ----------

export const accounts = {
  me: () => apiRequest<Me>("/auth/me"),
  /** How accounts work on this server: is email verification required? (public) */
  config: () => apiRequest<{ email_verification: boolean }>("/auth/config"),
  /** signed_in: verification is off on this server, the new account is already signed in. */
  signup: (b: { org_name: string; first_name: string; last_name: string; email: string; password: string }) =>
    apiRequest<Mailed & { email: string; signed_in?: boolean }>("/auth/signup", post(b)),
  login: (email: string, password: string) => apiRequest<{ ok: boolean }>("/auth/login", post({ email, password })),
  logout: () => apiRequest("/auth/logout", post()),
  logoutAll: () => apiRequest("/auth/logout-all", post()),
  verifyEmail: (token: string) => apiRequest("/auth/verify-email", post({ token })),
  resendVerification: (email: string) => apiRequest<Mailed>("/auth/resend-verification", post({ email })),
  forgotPassword: (email: string) => apiRequest<Mailed>("/auth/forgot-password", post({ email })),
  resetPassword: (token: string, password: string) => apiRequest("/auth/reset-password", post({ token, password })),
  invitation: (token: string) => apiRequest<InvitationInfo>("/auth/invitations/" + enc(token)),
  acceptInvitation: (token: string, b: { first_name?: string; last_name?: string; password: string }) =>
    apiRequest("/auth/invitations/" + enc(token) + "/accept", post(b)),
  updateMe: (b: { first_name: string; last_name: string; phone: string | null }) =>
    apiRequest("/auth/me", { method: "PATCH", ...json(b) }),
  changePassword: (current_password: string, new_password: string) =>
    apiRequest("/auth/change-password", post({ current_password, new_password })),
  switchOrg: (org_id: string) => apiRequest("/auth/switch-org", post({ org_id })),
  leaveOrg: () => apiRequest("/org/leave", post()),
  /** Demo access links (view-only, no account). The url (with its token) comes back only on create. */
  guestLinks: () => apiRequest<{ links: GuestLink[] }>("/org/guest-links"),
  createGuestLink: (label: string, hours: number) =>
    apiRequest<{ link: GuestLink; url: string }>("/org/guest-links", post({ label, hours })),
  revokeGuestLink: (id: string) => apiRequest("/org/guest-links/" + enc(id), { method: "DELETE" }),
  demoInfo: (token: string) =>
    apiRequest<{ org_name: string; label: string; expires_at: string }>("/auth/demo/" + enc(token)),
  demoEnter: (token: string) => apiRequest<{ ok: boolean; expires_at: string }>("/auth/demo/" + enc(token), post()),

  org: () => apiRequest<OrgProfile>("/org"),
  saveOrg: (p: OrgProfile) => apiRequest<OrgProfile>("/org", { method: "PUT", ...json(p) }),
  members: () => apiRequest<{ members: Member[]; invitations: Invitation[] }>("/org/members"),
  invite: (email: string, role: Role) =>
    apiRequest<Mailed & { invitation: Invitation; url: string }>("/org/invitations", post({ email, role })),
  /** url: the invitation link, to share directly (copy / QR code) as well as by email. */
  resendInvite: (id: string) => apiRequest<Mailed & { url: string }>("/org/invitations/" + enc(id) + "/resend", post()),
  revokeInvite: (id: string) => apiRequest("/org/invitations/" + enc(id), { method: "DELETE" }),
  setRole: (userId: string, role: Role) => apiRequest("/org/members/" + enc(userId), { method: "PATCH", ...json({ role }) }),
  removeMember: (userId: string) => apiRequest("/org/members/" + enc(userId), { method: "DELETE" }),
  permissions: () => apiRequest<RolePermissions>("/org/permissions"),
  savePermissions: (roles: Partial<Record<Role, string[]>>) =>
    apiRequest<RolePermissions>("/org/permissions", { method: "PUT", ...json({ roles }) }),
};

export const notifications = {
  settings: () => apiRequest<NotificationSettings>("/notification-settings"),
  save: (c: NotifyConfig) => apiRequest<{ config: NotifyConfig }>("/notification-settings", { method: "PUT", ...json(c) }),
  saveEmail: (p: EmailProvider) =>
    apiRequest<{ email_provider: EmailProvider }>("/notification-settings/email-provider", { method: "PUT", ...json(p) }),
  saveSMS: (p: SMSProvider) =>
    apiRequest<{ sms_provider: SMSProvider }>("/notification-settings/sms-provider", { method: "PUT", ...json(p) }),
  testEmail: (to: string, provider?: EmailProvider) =>
    apiRequest<{ ok: boolean; message: string; result: string }>("/notification-settings/test-email", post({ to, provider })),
  testSMS: (to: string, provider?: SMSProvider) =>
    apiRequest<{ ok: boolean; message: string; result: string }>("/notification-settings/test-sms", post({ to, provider })),
  preview: (event: NotifyEvent, template: Template) =>
    apiRequest<{ subject: string; body: string; sms: string }>("/notification-settings/preview", post({ event, template })),
  deliveries: () => apiRequest<{ deliveries: Delivery[] }>("/notification-settings/deliveries"),
};

export const incidentReports = {
  list: (incidentId?: string) =>
    apiRequest<{ reports: IncidentReport[]; forms: Record<ReportForm, string> }>(
      incidentId ? "/incidents/" + enc(incidentId) + "/reports" : "/incident-reports"),
  get: (id: string) => apiRequest<{ report: IncidentReport }>("/incident-reports/" + enc(id)),
  facts: (incidentId: string) => apiRequest<ReportFacts>("/incidents/" + enc(incidentId) + "/report-facts"),
  create: (incidentId: string, b: { form: ReportForm; title: string; content: ReportContent }) =>
    apiRequest<{ report: IncidentReport }>("/incidents/" + enc(incidentId) + "/reports", post(b)),
  save: (id: string, b: { title: string; status: "draft" | "final"; content: ReportContent }) =>
    apiRequest<{ report: IncidentReport }>("/incident-reports/" + enc(id), { method: "PUT", ...json(b) }),
  /** Moves it to Recently deleted, restorable for restorable_days. */
  remove: (id: string) => apiRequest<{ ok: boolean; restorable_days: number }>("/incident-reports/" + enc(id), { method: "DELETE" }),
  deleted: () => apiRequest<{ reports: IncidentReport[] }>("/incident-reports/deleted"),
  restore: (id: string) => apiRequest<{ report: IncidentReport }>("/incident-reports/" + enc(id) + "/restore", { method: "POST" }),
};

// ---- view-only share links (incident video for regulators) ----

export interface ShareLink {
  id: string;
  incident_id: string;
  recipient: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  views: number;
  last_viewed_at: string | null;
}

/** What the public /shared/:token page shows. Media URLs are API paths. */
export interface SharedView {
  organization: string;
  incident: {
    started_at: string;
    recovered_at: string | null;
    duration_seconds: number | null;
    status: string;
    location: string | null;
    zone: string | null;
  };
  timezone: string;
  expires_at: string;
  media: { camera: string; clip: string | null; snapshot: string | null }[] | null;
}

export const shareLinks = {
  list: (incidentId: string) => apiRequest<{ links: ShareLink[] }>("/incidents/" + enc(incidentId) + "/share-links"),
  /** url is shown only here: the server keeps just a hash of the token. */
  create: (incidentId: string, b: { recipient: string; days: number }) =>
    apiRequest<{ link: ShareLink; url: string }>("/incidents/" + enc(incidentId) + "/share-links", post(b)),
  revoke: (id: string) => apiRequest("/share-links/" + enc(id), { method: "DELETE" }),
  /** Public: no account needed, the token is the permission. */
  view: (token: string) => apiRequest<SharedView>("/shared/" + enc(token)),
};
