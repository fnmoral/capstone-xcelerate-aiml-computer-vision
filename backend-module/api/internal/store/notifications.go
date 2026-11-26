package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"backend-api/internal/notify"
)

// PlatformSecret returns a random secret stored in the database, creating it on first use.
// Used to encrypt provider passwords when APP_SECRET isn't set.
func (s *Store) PlatformSecret(ctx context.Context, name string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	var v string
	err := s.pool.QueryRow(ctx, `WITH ins AS (
			INSERT INTO platform_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING value)
		SELECT value FROM ins UNION ALL SELECT value FROM platform_secrets WHERE name = $1 LIMIT 1`,
		name, base64.StdEncoding.EncodeToString(b)).Scan(&v)
	return v, err
}

// NotificationSettings is an organization's notification setup.
type NotificationSettings struct {
	Config notify.Config
	Email  notify.EmailProvider
	SMS    notify.SMSProvider
}

func loadNotify(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, tid string) (*NotificationSettings, error) {
	var cfg, email, sms []byte
	err := q.QueryRow(ctx, `SELECT config, email_provider, sms_provider FROM notification_settings WHERE tenant_id = $1`, tid).
		Scan(&cfg, &email, &sms)
	out := &NotificationSettings{Config: notify.DefaultConfig()}
	if errors.Is(err, pgx.ErrNoRows) {
		out.Email.Type, out.SMS.Type = "log", "log"
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	if len(cfg) > 2 {
		out.Config = notify.Config{}
		if err := json.Unmarshal(cfg, &out.Config); err != nil {
			return nil, err
		}
	}
	out.Config = out.Config.Normalize()
	_ = json.Unmarshal(email, &out.Email)
	_ = json.Unmarshal(sms, &out.SMS)
	if out.Email.Type == "" {
		out.Email.Type = "log"
	}
	if out.SMS.Type == "" {
		out.SMS.Type = "log"
	}
	return out, nil
}

// Notifications returns the current organization's notification setup (defaults if never saved).
func (s *Store) Notifications(ctx context.Context) (*NotificationSettings, error) {
	var out *NotificationSettings
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var err error
		out, err = loadNotify(ctx, tx, tid)
		return err
	})
	return out, err
}

// NotificationsFor returns a given organization's setup (background jobs).
func (s *Store) NotificationsFor(ctx context.Context, tid string) (*NotificationSettings, error) {
	return loadNotify(ctx, s.pool, tid)
}

// saveNotify writes one column of notification_settings (creating the row: alerts from
// before that moment are never sent).
func (s *Store) saveNotify(ctx context.Context, column string, value any, actor, message string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		if _, err := tx.Exec(ctx, fmt.Sprintf(`INSERT INTO notification_settings (tenant_id, %[1]s) VALUES ($1, $2)
			ON CONFLICT (tenant_id) DO UPDATE SET %[1]s = EXCLUDED.%[1]s, updated_at = now()`, column), tid, value); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "settings.notifications", "settings", "", map[string]any{"message": message})
	})
}

// SaveNotificationConfig saves the matrix, recipients, follow-ups and templates.
func (s *Store) SaveNotificationConfig(ctx context.Context, c notify.Config, actor string) error {
	return s.saveNotify(ctx, "config", c, actor, "Notification settings changed")
}

// SaveEmailProvider saves how email is sent (password already encrypted).
func (s *Store) SaveEmailProvider(ctx context.Context, p notify.EmailProvider, actor string) error {
	return s.saveNotify(ctx, "email_provider", p, actor, "Email provider changed to "+p.Type)
}

// SaveSMSProvider saves how SMS is sent (auth token already encrypted).
func (s *Store) SaveSMSProvider(ctx context.Context, p notify.SMSProvider, actor string) error {
	return s.saveNotify(ctx, "sms_provider", p, actor, "SMS provider changed to "+p.Type)
}

// NotifyTenants lists organizations that saved notification settings.
func (s *Store) NotifyTenants(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT n.tenant_id::text FROM notification_settings n
		JOIN tenants t ON t.id = n.tenant_id AND t.status = 'active'`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// AlertForNotify is an alert with what messages about it need.
type AlertForNotify struct {
	ID, Severity, Status string
	TriggeredAt          time.Time
	Summary              *string
	IncidentID           *string
	CameraName           *string
	Location             *string
	Zone                 *string
	IncidentStatus       *string
	RecoveredAt          *time.Time
	DurationSeconds      *int
	ClosedBy             *string // who resolved / marked a false alarm
	Done                 map[string]bool
	OrgName, Timezone    string
}

// AlertsToNotify returns a tenant's recent alerts (since notifications were set up, at
// most 2 days back) with the events already handled.
func (s *Store) AlertsToNotify(ctx context.Context, tid string) ([]AlertForNotify, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.id::text, a.severity, a.status, a.triggered_at, a.summary, a.incident_id::text,
		       c.name, coalesce(i.location_label, c.location), i.zone, i.status, i.recovered_at, i.duration_seconds,
		       (SELECT l.details->>'actor' FROM audit_logs l WHERE l.tenant_id = a.tenant_id AND l.target_type = 'alert'
		          AND l.target_id = a.id AND l.action IN ('alert.resolved', 'alert.false_positive')
		          ORDER BY l.created_at DESC LIMIT 1),
		       coalesce((SELECT array_agg(e.event) FROM notification_events e WHERE e.alert_id = a.id), '{}'),
		       t.name, coalesce(t.timezone, 'UTC')
		FROM alerts a
		JOIN notification_settings n ON n.tenant_id = a.tenant_id
		JOIN tenants t ON t.id = a.tenant_id
		LEFT JOIN cameras c ON c.id = a.camera_id
		LEFT JOIN incidents i ON i.id = a.incident_id AND i.tenant_id = a.tenant_id
		WHERE a.tenant_id = $1 AND a.triggered_at >= greatest(n.enabled_at - interval '1 minute', now() - interval '2 days')
		  AND (i.id IS NULL OR i.deleted_at IS NULL)
		ORDER BY a.triggered_at LIMIT 500`, tid)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (AlertForNotify, error) {
		var a AlertForNotify
		var done []string
		err := r.Scan(&a.ID, &a.Severity, &a.Status, &a.TriggeredAt, &a.Summary, &a.IncidentID, &a.CameraName,
			&a.Location, &a.Zone, &a.IncidentStatus, &a.RecoveredAt, &a.DurationSeconds, &a.ClosedBy, &done,
			&a.OrgName, &a.Timezone)
		a.Done = map[string]bool{}
		for _, d := range done {
			a.Done[d] = true
		}
		return a, err
	})
}

// Delivery is one message to send.
type Delivery struct {
	ID        string     `json:"id"`
	TenantID  string     `json:"-"`
	AlertID   *string    `json:"alert_id"`
	Event     string     `json:"event"`
	Channel   string     `json:"channel"`
	Recipient string     `json:"recipient"`
	Subject   *string    `json:"subject"`
	Body      string     `json:"-"`
	Status    string     `json:"status"`
	Attempts  int        `json:"attempts"`
	Error     *string    `json:"error"`
	CreatedAt time.Time  `json:"created_at"`
	SentAt    *time.Time `json:"sent_at"`
}

// QueueEvent records that an alert event was handled and queues its messages, once:
// it returns false (and queues nothing) if the event was already handled.
func (s *Store) QueueEvent(ctx context.Context, tid, alertID, event string, msgs []Delivery) (bool, error) {
	queued := false
	err := s.plain(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `INSERT INTO notification_events (tenant_id, alert_id, event) VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING`, tid, alertID, event)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		queued = true
		for _, m := range msgs {
			if _, err := tx.Exec(ctx, `INSERT INTO notification_deliveries (tenant_id, alert_id, event, channel, recipient, subject, body)
				VALUES ($1, $2, $3, $4, $5, $6, $7)`, tid, alertID, m.Event, m.Channel, m.Recipient, m.Subject, m.Body); err != nil {
				return err
			}
		}
		return nil
	})
	return queued, err
}

// LogTestDelivery records a test message sent from the Notifications page.
func (s *Store) LogTestDelivery(ctx context.Context, channel, recipient, subject, body, status string, sendErr *string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		_, err := tx.Exec(ctx, `INSERT INTO notification_deliveries (tenant_id, event, channel, recipient, subject, body,
			status, attempts, error, sent_at) VALUES ($1, 'test', $2, $3, nullif($4, ''), $5, $6, 1, $7,
			CASE WHEN $6 = 'failed' THEN NULL ELSE now() END)`, tid, channel, recipient, subject, body, status, sendErr)
		return err
	})
}

// AlertRecipients lists who got an alert's messages: channel → recipients.
func (s *Store) AlertRecipients(ctx context.Context, alertID string) (map[string][]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT channel, recipient FROM notification_deliveries
		WHERE alert_id = $1 AND event LIKE 'alert%'`, alertID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var ch, to string
		if err := rows.Scan(&ch, &to); err != nil {
			return nil, err
		}
		out[ch] = append(out[ch], to)
	}
	return out, rows.Err()
}

// PendingDeliveries returns messages due to be sent (any tenant).
func (s *Store) PendingDeliveries(ctx context.Context, limit int) ([]Delivery, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text, tenant_id::text, alert_id::text, event, channel, recipient, subject,
		body, status, attempts, error, created_at, sent_at FROM notification_deliveries
		WHERE status = 'pending' AND next_try_at <= now() ORDER BY created_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanDelivery)
}

func scanDelivery(r pgx.CollectableRow) (Delivery, error) {
	var d Delivery
	err := r.Scan(&d.ID, &d.TenantID, &d.AlertID, &d.Event, &d.Channel, &d.Recipient, &d.Subject, &d.Body,
		&d.Status, &d.Attempts, &d.Error, &d.CreatedAt, &d.SentAt)
	return d, err
}

// MaxAttempts is how many times a message is tried before it is marked failed.
const MaxAttempts = 4

// DeliveryDone records the outcome of a send. A failure is retried later (1, 5, 15 min)
// until MaxAttempts.
func (s *Store) DeliveryDone(ctx context.Context, id string, result string, sendErr error) error {
	if sendErr == nil {
		_, err := s.pool.Exec(ctx, `UPDATE notification_deliveries SET status = $2, attempts = attempts + 1,
			error = NULL, sent_at = now() WHERE id = $1`, id, result)
		return err
	}
	_, err := s.pool.Exec(ctx, `UPDATE notification_deliveries SET attempts = attempts + 1, error = left($2, 500),
		status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
		next_try_at = now() + (CASE attempts WHEN 0 THEN 1 WHEN 1 THEN 5 ELSE 15 END) * interval '1 minute'
		WHERE id = $1`, id, sendErr.Error(), MaxAttempts)
	return err
}

// Deliveries lists the organization's latest messages (newest first).
func (s *Store) Deliveries(ctx context.Context, limit int) ([]Delivery, error) {
	out := []Delivery{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT id::text, tenant_id::text, alert_id::text, event, channel, recipient, subject,
			body, status, attempts, error, created_at, sent_at FROM notification_deliveries
			WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, tid, limit)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, scanDelivery)
		return err
	})
	return out, err
}
