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
  type: "log" | "smtp";
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
}

/** Field values of a report; auto lists fields filled from FallGuard records. */
export interface ReportContent {
  fields?: Record<string, string>;
  auto?: string[];
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
  signup: (b: { org_name: string; first_name: string; last_name: string; email: string; password: string }) =>
    apiRequest<Mailed & { email: string }>("/auth/signup", post(b)),
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

  org: () => apiRequest<OrgProfile>("/org"),
  saveOrg: (p: OrgProfile) => apiRequest<OrgProfile>("/org", { method: "PUT", ...json(p) }),
  members: () => apiRequest<{ members: Member[]; invitations: Invitation[] }>("/org/members"),
  invite: (email: string, role: Role) =>
    apiRequest<Mailed & { invitation: Invitation }>("/org/invitations", post({ email, role })),
  resendInvite: (id: string) => apiRequest<Mailed>("/org/invitations/" + enc(id) + "/resend", post()),
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
  remove: (id: string) => apiRequest("/incident-reports/" + enc(id), { method: "DELETE" }),
};
