import type { IncidentReport, ReportFacts, ReportForm } from '../../services/api/accounts';

/**
 * Incident report forms. Each field may have `auto`, which fills it from FallGuard's
 * records (incident, cameras, alert handling, notes, organization profile). Everything
 * FallGuard can't know (the injured person, the injury, wages...) stays for people to fill in.
 *
 * The fields follow the information each authority asks for; the app produces a completed
 * summary to transcribe or attach, not the authority's official (fillable) form.
 */

export type FieldType = 'text' | 'textarea' | 'date' | 'time' | 'select' | 'number';

/** Which earlier reports a new report copies a field from (what a person typed there):
 *  incident = this incident's other reports (the same person and injury) — the copy replaces
 *  an auto-filled value; org = any report, preparer = reports by the same preparer — these
 *  only fill a field left empty (the organization profile comes first). */
export type Reuse = 'incident' | 'org' | 'preparer';

export interface Field {
  key: string;
  label: string;
  type?: FieldType;
  options?: string[];
  help?: string;
  required?: boolean;
  wide?: boolean;
  auto?: (f: ReportFacts) => string;
  reuse?: Reuse;
  /** The same question in other forms when the key differs (worker_name = person_name). */
  same?: string;
}

export interface Section {
  title: string;
  note?: string;
  fields: Field[];
}

export interface FormDef {
  id: ReportForm;
  name: string;
  short: string;
  authority: string;
  deadline: string;
  description: string;
  disclaimer: string;
  sections: Section[];
}

// ---------- helpers that read the facts ----------

const tz = (f: ReportFacts) => f.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

function parts(iso: string, zone: string) {
  const d = new Date(iso);
  const get = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, ...o }).format(d);
  return {
    date: get({ year: 'numeric', month: '2-digit', day: '2-digit' }), // YYYY-MM-DD
    time: get({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    long: new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(d),
  };
}

export const when = (f: ReportFacts, iso: string | null | undefined) => (iso ? parts(iso, tz(f)) : null);

function duration(sec: number | null | undefined) {
  if (sec == null) return null;
  if (sec < 60) return `${sec} seconds`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m} min ${s} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const orgName = (f: ReportFacts) => f.org.legal_name || f.org.name;
const orgAddress = (f: ReportFacts) =>
  [f.org.address, [f.org.city, f.org.province].filter(Boolean).join(', '), f.org.postal_code, f.org.country].filter(Boolean).join(', ');

const mainCamera = (f: ReportFacts) => f.cameras[0];
const place = (f: ReportFacts) => {
  const c = mainCamera(f);
  const loc = f.incident.location_label || c?.location;
  const bits = [loc, f.incident.zone ? `zone ${f.incident.zone}` : null, `camera ${f.incident.camera_name ?? c?.name ?? 'unknown'}`].filter(Boolean);
  return bits.join(', ');
};

const statusText: Record<string, string> = {
  active: 'the person was still down when this report was prepared',
  recovered: 'the person got back up',
  unresolved: 'the person left the camera view while still down',
  false_positive: 'the alert was marked as a false alarm',
};

/** Who acted on the incident, from the activity log (staff who responded). */
function responders(f: ReportFacts): string[] {
  const names = new Set<string>();
  for (const e of f.activity) if (e.actor && e.actor !== 'System') names.add(e.actor);
  f.incident.note_list.forEach((n) => n.author && names.add(n.author));
  return [...names];
}

function firstAction(f: ReportFacts, action: string) {
  return [...f.activity].reverse().find((e) => e.action === action);
}

/** Plain-language account of what FallGuard recorded. */
export function narrative(f: ReportFacts): string {
  const i = f.incident;
  const start = when(f, i.started_at)!;
  const lines = [
    `On ${start.long}, FallGuard's fall detection identified a fall at ${place(f)}.`,
  ];
  if (i.cameras.length > 1) lines.push(`${i.cameras.length} cameras recorded the event (${f.cameras.map((c) => c.name).filter(Boolean).join(', ')}).`);
  if (i.recovered_at) lines.push(`The person was on the ground for about ${duration(i.duration_seconds)} and was seen getting up at ${when(f, i.recovered_at)!.time}.`);
  else lines.push(`Outcome recorded by the system: ${statusText[i.status] ?? i.status}.`);
  if (i.alert) {
    const ack = i.alert.acknowledged_at ? when(f, i.alert.acknowledged_at)! : null;
    if (ack) lines.push(`The alert (severity ${i.severity}) was acknowledged by ${i.alert.acknowledged_by ?? 'staff'} at ${ack.time}.`);
    if (i.alert.status === 'resolved' && i.alert.closed_at) lines.push(`It was resolved by ${i.alert.closed_by ?? 'staff'} at ${when(f, i.alert.closed_at)!.time}.`);
    if (i.alert.status === 'false_positive') lines.push(`It was marked as a false alarm by ${i.alert.closed_by ?? 'staff'}.`);
  }
  return lines.join(' ');
}

/** Timeline of the incident, one event per line. */
export function timeline(f: ReportFacts): string {
  const rows: [string, string][] = [[f.incident.started_at, 'Fall detected by FallGuard']];
  if (f.incident.alert) rows.push([f.incident.alert.triggered_at, `Alert raised (severity ${f.incident.severity})`]);
  for (const e of f.activity) rows.push([e.at, `${e.message}${e.actor ? ` (${e.actor})` : ''}`]);
  if (f.incident.recovered_at) rows.push([f.incident.recovered_at, 'Person seen getting up']);
  return rows.sort((a, b) => a[0].localeCompare(b[0])).map(([at, text]) => `${when(f, at)!.date} ${when(f, at)!.time}  ${text}`).join('\n');
}

function notesText(f: ReportFacts) {
  return f.incident.note_list.map((n) => `${when(f, n.at)!.time} ${n.author}: ${n.text}`).join('\n');
}

/** Stands for the recipient's view-only video link in the Evidence text, until it's filled in. */
export const SHARE_PLACEHOLDER = '[share link]';
/** Days a video link created with a report stays valid. */
export const REPORT_SHARE_DAYS = 30;

/** Puts a share link in place of the placeholder (no change if there is none). */
export const withShareLink = (text: string, url: string) => text.replace(SHARE_PLACEHOLDER, url);

/** The share link already in a text, if any (kept when the auto-filled text is refreshed). */
export const shareLinkIn = (text: string | undefined) => text?.match(/https?:\/\/\S+\/shared\/[A-Za-z0-9_-]+/)?.[0] ?? null;

/** The evidence FallGuard holds, grouped under headings; videoLink adds the recipient's
 *  view-only video link (reports for an authority). */
export function evidence(f: ReportFacts, videoLink = true): string {
  const i = f.incident;
  const cameras = f.cameras.map((c) => (c.location && c.location !== c.name ? `${c.name} (${c.location})` : c.name ?? 'Camera'));
  const clips = f.cameras.filter((c) => c.clip_key).length;
  const snaps = f.cameras.filter((c) => c.snapshot_key).length;
  const confidence = i.peak_confidence != null ? `${Math.round(i.peak_confidence * 100)}%` : 'Not recorded';
  const lines = [
    `Incident reference: ${i.id}`,
    'Source: FallGuard Vision automated fall detection',
    '',
    'Video evidence',
    ...(videoLink ? [`  Video link (view-only, valid ${REPORT_SHARE_DAYS} days): ${SHARE_PLACEHOLDER}`] : []),
    `  Recordings retained: ${clips} video clip${clips === 1 ? '' : 's'}, ${snaps} snapshot${snaps === 1 ? '' : 's'}`,
    `  Camera${cameras.length === 1 ? '' : 's'}: ${cameras.join('; ') || 'Not recorded'}`,
    '',
    'Detection',
    `  Peak detection confidence: ${confidence}`,
    `  Detector readings: ${f.prediction_count} (one per second)`,
    '',
    'Staff access',
    `  Incident record (FallGuard account required): ${f.app_url}/events/${i.id}`,
  ];
  return lines.join('\n');
}

const today = (f: ReportFacts) => when(f, f.generated_at)!.date;
const incDate = (f: ReportFacts) => when(f, f.incident.started_at)!.date;
const incTime = (f: ReportFacts) => when(f, f.incident.started_at)!.time;
const reportedTo = (f: ReportFacts) => firstAction(f, 'alert.acknowledged')?.actor ?? f.prepared_by.name;
const reportedDate = (f: ReportFacts) => when(f, firstAction(f, 'alert.acknowledged')?.at ?? f.incident.started_at)!.date;
/** A sentence to edit, not a finding: the people who acted on the alert in the app are only a
 *  suggestion for who responded (the app user may not have been at the scene). The [ ] parts
 *  are for people to fill in. */
const witnessText = (contact: string) => (f: ReportFacts) => {
  const r = responders(f);
  return `Witnesses: [name], [job title], [${contact}].\nResponded at the scene: ${r.length ? r.join(', ') : '[names]'}.`;
};
const WITNESS_HELP = 'A suggested wording: change the names or the sentence. "Responded at the scene" lists who acted on the alert in FallGuard; they may not have been there.';

// ---------- shared field groups ----------

const preparedBy = (extra: Field[] = []): Section => ({
  title: 'Prepared by',
  fields: [
    { key: 'preparer_name', label: 'Name', required: true, auto: (f) => f.prepared_by.name },
    { key: 'preparer_title', label: 'Title / position', required: true, reuse: 'preparer' },
    { key: 'preparer_phone', label: 'Phone', auto: (f) => f.prepared_by.phone ?? f.org.phone, reuse: 'preparer' },
    { key: 'preparer_email', label: 'Email', auto: (f) => f.prepared_by.email },
    { key: 'date_prepared', label: 'Date prepared', type: 'date', required: true, auto: today },
    ...extra,
  ],
});

/** FallGuard's evidence; videoLink: the report goes to an authority, which gets a video link. */
const fallGuardEvidence = (videoLink = true): Section => ({
  title: 'FallGuard records (video and detection evidence)',
  note: 'Keep the video clips and snapshots: authorities and insurers may ask for them.',
  fields: [
    {
      key: 'evidence_summary', label: 'Evidence', type: 'textarea', wide: true, auto: (f) => evidence(f, videoLink),
      help: videoLink
        ? `The view-only video link is created with the report and stays valid for ${REPORT_SHARE_DAYS} days. Manage or revoke it under "Share video" on the incident page.`
        : undefined,
    },
    { key: 'timeline', label: 'Timeline', type: 'textarea', wide: true, auto: timeline },
  ],
});

const YES_NO = ['Yes', 'No'];
const YES_NO_UNKNOWN = ['Yes', 'No', 'Not known yet'];

// ---------- the forms ----------

export const FORMS: FormDef[] = [
  {
    id: 'wsib_form7',
    name: "WSIB Form 7: Employer's Report of Injury/Illness",
    short: 'WSIB Form 7',
    authority: 'Workplace Safety and Insurance Board (Ontario)',
    deadline: 'Within 3 business days of learning that a worker needed health care beyond first aid, lost time or earnings, or was on modified work.',
    description: 'For a worker injured at work in Ontario. Submit through WSIB online services (eForm 7) or by mail/fax; give the worker a copy.',
    disclaimer: 'Prepared from FallGuard records to help complete WSIB Form 7. Transcribe it into the official Form 7 (WSIB online services) and check every answer; WSIB asks for some details (such as the worker\'s SIN and earnings) that are not kept here.',
    sections: [
      {
        title: 'A. Worker',
        fields: [
          { key: 'worker_name', label: 'Worker full name', required: true, reuse: 'incident', same: 'person_name' },
          { key: 'worker_job_title', label: 'Job title / occupation', required: true, reuse: 'incident', same: 'person_job' },
          { key: 'worker_address', label: 'Home address', wide: true, reuse: 'incident', same: 'person_address' },
          { key: 'worker_phone', label: 'Phone', reuse: 'incident' },
          { key: 'worker_dob', label: 'Date of birth', type: 'date', reuse: 'incident', same: 'person_dob' },
          { key: 'worker_hire_date', label: 'Date hired', type: 'date', reuse: 'incident', same: 'person_hired' },
          { key: 'worker_language', label: 'Preferred language', options: ['English', 'French', 'Other'], type: 'select', reuse: 'incident' },
          { key: 'worker_employment', label: 'Employment type', type: 'select', options: ['Full-time', 'Part-time', 'Casual', 'Seasonal', 'Student / trainee', 'Other'], reuse: 'incident' },
        ],
      },
      {
        title: 'B. Employer',
        fields: [
          { key: 'employer_name', label: 'Legal name', required: true, auto: orgName, reuse: 'org' },
          { key: 'employer_trade_name', label: 'Trade name', auto: (f) => f.org.name, reuse: 'org' },
          { key: 'employer_address', label: 'Address', wide: true, auto: orgAddress, reuse: 'org' },
          { key: 'employer_phone', label: 'Phone', auto: (f) => f.org.phone, reuse: 'org' },
          { key: 'wsib_firm_number', label: 'WSIB firm number', required: true, auto: (f) => f.org.wsib_firm_number, reuse: 'org' },
          { key: 'wsib_rate_group', label: 'Rate group / classification unit', auto: (f) => f.org.wsib_rate_group, reuse: 'org' },
          { key: 'business_type', label: 'Type of business', auto: (f) => f.org.business_type, reuse: 'org' },
        ],
      },
      {
        title: 'C. Accident / illness details',
        fields: [
          { key: 'accident_date', label: 'Date of accident', type: 'date', required: true, auto: incDate },
          { key: 'accident_time', label: 'Time of accident', type: 'time', required: true, auto: incTime },
          { key: 'reported_date', label: 'Date reported to employer', type: 'date', auto: reportedDate },
          { key: 'reported_to', label: 'Reported to (name)', auto: reportedTo },
          { key: 'accident_location', label: 'Where it happened', wide: true, required: true, auto: place },
          { key: 'on_premises', label: "On the employer's premises?", type: 'select', options: YES_NO, auto: () => 'Yes' },
          { key: 'how_it_happened', label: 'Describe how the accident happened', type: 'textarea', wide: true, required: true, auto: narrative, reuse: 'incident', same: 'what_happened' },
          { key: 'activity', label: 'What was the worker doing at the time?', type: 'textarea', wide: true, required: true, reuse: 'incident' },
          { key: 'body_part', label: 'Part(s) of body injured', required: true, reuse: 'incident' },
          { key: 'body_side', label: 'Side of body', type: 'select', options: ['Left', 'Right', 'Both', 'Not applicable'], reuse: 'incident' },
          { key: 'injury_nature', label: 'Nature of injury (e.g. sprain, fracture, bruise)', required: true, reuse: 'incident' },
          { key: 'equipment', label: 'Equipment, materials or conditions involved', wide: true, reuse: 'incident' },
          { key: 'witnesses', label: 'Witnesses', type: 'textarea', wide: true, auto: witnessText('phone or email'), help: WITNESS_HELP, reuse: 'incident' },
          { key: 'first_aid', label: 'First aid given?', type: 'select', options: YES_NO, reuse: 'incident' },
          { key: 'health_care_date', label: 'Date health care first received', type: 'date', reuse: 'incident' },
          { key: 'health_care_provider', label: 'Health care provider / facility', wide: true, reuse: 'incident' },
        ],
      },
      {
        title: 'D. Lost time and return to work',
        fields: [
          { key: 'lost_time', label: 'Lost time beyond the day of injury?', type: 'select', options: YES_NO_UNKNOWN, reuse: 'incident' },
          { key: 'last_day_worked', label: 'Last day worked', type: 'date', reuse: 'incident' },
          { key: 'modified_work', label: 'Modified work offered?', type: 'select', options: YES_NO_UNKNOWN, reuse: 'incident' },
          { key: 'return_date', label: 'Return-to-work date', type: 'date', reuse: 'incident' },
          { key: 'regular_hours', label: 'Regular work schedule / hours', wide: true, reuse: 'incident' },
        ],
      },
      fallGuardEvidence(),
      preparedBy(),
    ],
  },
  {
    id: 'ohsa_notice',
    name: 'OHSA written notice to the Ministry of Labour (s.51 / s.52)',
    short: 'OHSA notice',
    authority: 'Ontario Ministry of Labour, Immigration, Training and Skills Development',
    deadline: 's.51 critical injury or death: notify an inspector, the joint health and safety committee (or representative) and the union immediately, written report within 48 hours; preserve the scene. s.52 accident causing disability, or occupational illness: written notice within 4 days.',
    description: 'Written notice required by the Occupational Health and Safety Act, with the details listed in O. Reg. 420/21.',
    disclaimer: 'Prepared from FallGuard records. Check the notice type and contents against the Occupational Health and Safety Act and O. Reg. 420/21 before sending it to a Director/inspector, the joint health and safety committee and the trade union.',
    sections: [
      {
        title: 'Notice',
        fields: [
          {
            key: 'notice_type', label: 'Type of notice', type: 'select', required: true, wide: true,
            options: ['s.51: critical injury or death', 's.52(1): accident, explosion or fire causing disability or medical attention', 's.52(2): occupational illness'], reuse: 'incident',
          },
          { key: 'mol_notified', label: 'Inspector / Ministry notified (date, time, by phone?)', wide: true, reuse: 'incident' },
          { key: 'jhsc_notified', label: 'Joint H&S committee or representative notified', wide: true, reuse: 'incident' },
          { key: 'union_notified', label: 'Trade union notified (if any)', wide: true, reuse: 'incident' },
          { key: 'scene_preserved', label: 'Scene preserved (s.51(2))?', type: 'select', options: ['Yes', 'No', 'Not applicable'], reuse: 'incident' },
        ],
      },
      {
        title: 'Employer and workplace',
        fields: [
          { key: 'employer_name', label: 'Employer name', required: true, auto: orgName, reuse: 'org' },
          { key: 'employer_address', label: 'Employer address', wide: true, auto: orgAddress, reuse: 'org' },
          { key: 'employer_phone', label: 'Phone', auto: (f) => f.org.phone, reuse: 'org' },
          { key: 'workplace', label: 'Where the occurrence happened', wide: true, required: true, auto: place },
          { key: 'occurrence_date', label: 'Date', type: 'date', required: true, auto: incDate },
          { key: 'occurrence_time', label: 'Time', type: 'time', required: true, auto: incTime },
        ],
      },
      {
        title: 'Injured person',
        fields: [
          { key: 'person_name', label: 'Name', required: true, reuse: 'incident' },
          { key: 'person_address', label: 'Address', wide: true, reuse: 'incident' },
          { key: 'person_occupation', label: 'Occupation / job title', reuse: 'incident', same: 'person_job' },
          { key: 'person_employer', label: 'Employer (if not the employer above)', reuse: 'incident' },
        ],
      },
      {
        title: 'Occurrence',
        fields: [
          { key: 'circumstances', label: 'Nature and circumstances of the occurrence', type: 'textarea', wide: true, required: true, auto: narrative, reuse: 'incident', same: 'what_happened' },
          { key: 'bodily_injury', label: 'Description of the bodily injury', type: 'textarea', wide: true, required: true, reuse: 'incident', same: 'injury' },
          { key: 'equipment', label: 'Machinery, equipment or materials involved', type: 'textarea', wide: true, reuse: 'incident' },
          { key: 'witnesses', label: 'Names and addresses of witnesses', type: 'textarea', wide: true, auto: witnessText('address'), help: WITNESS_HELP, reuse: 'incident' },
          { key: 'physician', label: 'Name and address of attending physician / health care provider', wide: true, reuse: 'incident', same: 'health_care_provider' },
          { key: 'prevention', label: 'Steps taken to prevent a recurrence', type: 'textarea', wide: true, required: true, reuse: 'incident', same: 'corrective_actions' },
        ],
      },
      fallGuardEvidence(),
      preparedBy(),
    ],
  },
  {
    id: 'osha_301',
    name: 'OSHA Form 301: Injury and Illness Incident Report',
    short: 'OSHA 301',
    authority: 'U.S. Occupational Safety and Health Administration',
    deadline: 'Within 7 calendar days of learning of a recordable work-related injury or illness. Fatalities must be reported to OSHA within 8 hours; in-patient hospitalization, amputation or loss of an eye within 24 hours.',
    description: 'Incident report for a recordable case, plus the matching OSHA 300 Log entry.',
    disclaimer: 'Prepared from FallGuard records to help complete OSHA Form 301 and the OSHA 300 Log. Confirm the case is recordable (29 CFR 1904) and keep the form for 5 years.',
    sections: [
      {
        title: 'Information about the employee',
        fields: [
          { key: 'employee_name', label: '1. Full name', required: true, reuse: 'incident', same: 'person_name' },
          { key: 'employee_street', label: '2. Street', wide: true, reuse: 'incident' },
          { key: 'employee_city', label: 'City, state, ZIP', reuse: 'incident' },
          { key: 'employee_dob', label: '3. Date of birth', type: 'date', reuse: 'incident', same: 'person_dob' },
          { key: 'employee_hired', label: '4. Date hired', type: 'date', reuse: 'incident', same: 'person_hired' },
          { key: 'employee_sex', label: '5. Sex', type: 'select', options: ['Male', 'Female', 'Not stated'], reuse: 'incident' },
          { key: 'employee_job', label: 'Job title (300 Log)', required: true, reuse: 'incident', same: 'person_job' },
        ],
      },
      {
        title: 'Information about the physician or other health care professional',
        fields: [
          { key: 'physician', label: '6. Name of physician or health care professional', reuse: 'incident' },
          { key: 'facility', label: '7. If treated away from the worksite: facility name and address', wide: true, reuse: 'incident', same: 'health_care_provider' },
          { key: 'emergency_room', label: '8. Treated in an emergency room?', type: 'select', options: YES_NO, reuse: 'incident' },
          { key: 'hospitalized', label: '9. Hospitalized overnight as an in-patient?', type: 'select', options: YES_NO, reuse: 'incident' },
        ],
      },
      {
        title: 'Information about the case',
        fields: [
          { key: 'case_number', label: '10. Case number from the Log', required: true, reuse: 'incident' },
          { key: 'injury_date', label: '11. Date of injury or illness', type: 'date', required: true, auto: incDate },
          { key: 'began_work', label: '12. Time employee began work', type: 'time', reuse: 'incident' },
          { key: 'event_time', label: '13. Time of event', type: 'time', auto: incTime },
          { key: 'doing_before', label: '14. What was the employee doing just before the incident occurred?', type: 'textarea', wide: true, required: true, reuse: 'incident', same: 'activity' },
          { key: 'what_happened', label: '15. What happened? Tell us how the injury occurred.', type: 'textarea', wide: true, required: true, auto: narrative, reuse: 'incident' },
          { key: 'injury', label: '16. What was the injury or illness? (part of body and how it was affected)', type: 'textarea', wide: true, required: true, reuse: 'incident' },
          { key: 'object', label: '17. What object or substance directly harmed the employee?', wide: true, auto: () => 'Floor / ground surface (fall)' },
          { key: 'death_date', label: '18. If the employee died, date of death', type: 'date', reuse: 'incident' },
        ],
      },
      {
        title: 'OSHA 300 Log entry',
        fields: [
          { key: 'where', label: 'Where the event occurred', wide: true, auto: place },
          { key: 'classification', label: 'Classify the case', type: 'select', required: true, options: ['Death', 'Days away from work', 'Job transfer or restriction', 'Other recordable case'], reuse: 'incident' },
          { key: 'days_away', label: 'Days away from work', type: 'number', reuse: 'incident' },
          { key: 'days_restricted', label: 'Days on job transfer or restriction', type: 'number', reuse: 'incident' },
          { key: 'injury_type', label: 'Injury or illness type', type: 'select', options: ['Injury', 'Skin disorder', 'Respiratory condition', 'Poisoning', 'Hearing loss', 'All other illnesses'], auto: () => 'Injury' },
          { key: 'privacy_case', label: 'Privacy case (name withheld on the Log)?', type: 'select', options: YES_NO, reuse: 'incident' },
          { key: 'establishment', label: 'Establishment name', auto: (f) => f.org.establishment || f.org.name, reuse: 'org' },
        ],
      },
      fallGuardEvidence(),
      preparedBy(),
    ],
  },
  {
    id: 'internal',
    name: 'Internal incident investigation report',
    short: 'Internal report',
    authority: 'Your organization',
    deadline: 'As set by your policy (typically within 24–72 hours).',
    description: 'A general incident and investigation report: what happened, response, root cause and corrective actions. Works for staff, residents, patients or visitors.',
    disclaimer: 'Internal record prepared from FallGuard data. Some falls also require a government report (WSIB, OHSA, OSHA, or your health authority).',
    sections: [
      {
        title: 'Incident summary',
        fields: [
          { key: 'incident_date', label: 'Date', type: 'date', required: true, auto: incDate },
          { key: 'incident_time', label: 'Time', type: 'time', required: true, auto: incTime },
          { key: 'location', label: 'Location', wide: true, auto: place },
          { key: 'severity', label: 'FallGuard severity', auto: (f) => f.incident.severity },
          { key: 'time_down', label: 'Time on the ground', auto: (f) => duration(f.incident.duration_seconds) ?? 'Unknown' },
          { key: 'outcome', label: 'Outcome recorded', auto: (f) => statusText[f.incident.status] ?? f.incident.status },
          {
            key: 'response_time', label: 'Time to acknowledge the alert', auto: (f) => {
              const a = f.incident.alert;
              return a?.acknowledged_at ? duration(Math.round((Date.parse(a.acknowledged_at) - Date.parse(a.triggered_at)) / 1000)) ?? '' : 'Not acknowledged';
            },
          },
        ],
      },
      {
        title: 'Person involved',
        fields: [
          { key: 'person_type', label: 'Person', type: 'select', required: true, options: ['Employee', 'Resident', 'Patient', 'Visitor', 'Contractor', 'Unknown'], reuse: 'incident' },
          { key: 'person_name', label: 'Name (or identifier)', reuse: 'incident' },
          { key: 'injury_level', label: 'Injury', type: 'select', required: true, options: ['No injury', 'Minor (first aid)', 'Medical treatment', 'Serious / hospitalized', 'Fatal', 'Not known yet'], reuse: 'incident' },
          { key: 'injury_details', label: 'Injury details', type: 'textarea', wide: true, reuse: 'incident', same: 'injury' },
        ],
      },
      {
        title: 'What happened and the response',
        fields: [
          { key: 'description', label: 'Description', type: 'textarea', wide: true, required: true, auto: narrative, reuse: 'incident', same: 'what_happened' },
          { key: 'immediate_actions', label: 'Immediate actions taken', type: 'textarea', wide: true, required: true, auto: notesText },
          { key: 'witnesses', label: 'Witnesses / responders', type: 'textarea', wide: true, auto: witnessText('phone or email'), help: WITNESS_HELP, reuse: 'incident' },
          { key: 'notified', label: 'Who was notified (family, physician, management, authorities)', type: 'textarea', wide: true, reuse: 'incident' },
        ],
      },
      {
        title: 'Investigation',
        fields: [
          {
            key: 'factors', label: 'Contributing factors', type: 'textarea', wide: true, reuse: 'incident',
            help: 'e.g. wet or uneven floor, lighting, footwear, mobility or balance, medication, equipment, staffing, procedure not followed',
          },
          { key: 'root_cause', label: 'Root cause', type: 'textarea', wide: true, required: true, reuse: 'incident' },
          { key: 'corrective_actions', label: 'Corrective actions (action, owner, due date)', type: 'textarea', wide: true, required: true, reuse: 'incident' },
          { key: 'follow_up_date', label: 'Follow-up review date', type: 'date', reuse: 'incident' },
        ],
      },
      fallGuardEvidence(false),
      preparedBy([
        { key: 'reviewed_by', label: 'Reviewed by' },
        { key: 'review_date', label: 'Review date', type: 'date' },
      ]),
    ],
  },
];

export const formById = (id: string) => FORMS.find((f) => f.id === id);

/** Fills every auto field of a form from the facts. */
export function autoFill(form: FormDef, facts: ReportFacts): { fields: Record<string, string>; auto: string[] } {
  const fields: Record<string, string> = {};
  const auto: string[] = [];
  for (const s of form.sections) {
    for (const fd of s.fields) {
      if (!fd.auto) continue;
      try {
        const v = fd.auto(facts);
        if (v) {
          fields[fd.key] = v;
          auto.push(fd.key);
        }
      } catch {
        /* missing data: leave the field for people to fill in */
      }
    }
  }
  return { fields, auto };
}

const concept = (f: Field) => f.same ?? f.key;
const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Adds to a new report what people typed in earlier reports (see Reuse), so the same answers
 * aren't typed again. `filled` is the new report's auto-fill; `earlier` the organization's
 * reports, newest first (the newest answer wins). Auto-filled values in earlier reports are
 * skipped: those are recalculated from each incident's records. `from` names the source of
 * each copied field, to show next to it.
 */
export function carryOver(form: FormDef, incidentId: string, filled: { fields: Record<string, string>; auto: string[] },
  earlier: IncidentReport[]): { fields: Record<string, string>; auto: string[]; from: Record<string, string> } {
  const fields = { ...filled.fields };
  const auto = new Set(filled.auto);
  const from: Record<string, string> = {};
  const preparer = norm(fields.preparer_name);
  for (const fd of form.sections.flatMap((s) => s.fields)) {
    if (!fd.reuse) continue;
    if (fd.reuse !== 'incident' && (fields[fd.key] ?? '').trim()) continue; // the profile / auto-fill comes first
    for (const r of earlier) {
      if (fd.reuse === 'incident' && r.incident_id !== incidentId) continue;
      if (fd.reuse === 'preparer' && (!preparer || norm(r.content.fields?.preparer_name) !== preparer)) continue;
      const src = formById(r.form)?.sections.flatMap((s) => s.fields).find((s) => s.reuse && concept(s) === concept(fd));
      const value = src && r.content.fields?.[src.key];
      if (!src || !value?.trim() || r.content.auto?.includes(src.key)) continue;
      fields[fd.key] = value;
      auto.delete(fd.key);
      from[fd.key] = formById(r.form)!.short + (r.incident_id === incidentId ? '' : ', an earlier incident');
      break;
    }
  }
  return { fields, auto: [...auto], from };
}

/** A template blank still to fill in, such as "[name]" in the witness sentence. */
export const hasBlanks = (value: string | undefined) => /\[[^\]\n]{1,40}\]/.test(value ?? '');

/** Required fields still empty, and any field with template blanks ([name]) left in. */
export function missing(form: FormDef, fields: Record<string, string>): Field[] {
  return form.sections.flatMap((s) => s.fields)
    .filter((f) => (f.required && !(fields[f.key] ?? '').trim()) || hasBlanks(fields[f.key]));
}
