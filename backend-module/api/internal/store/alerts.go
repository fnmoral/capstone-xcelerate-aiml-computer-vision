package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// AlertActionText is how each alert status change reads in the activity log.
var AlertActionText = map[string]string{
	"acknowledged":   "Alert acknowledged",
	"resolved":       "Alert resolved",
	"false_positive": "Marked as a false alarm",
}

// ErrNotClosed is returned when reopening an alert that isn't resolved or a false alarm.
var ErrNotClosed = errors.New("only a resolved alert or a false alarm can be reopened")

// queryAlerts runs an alert query; where is a condition on alias "a" using $1, $2, ...
// Who acknowledged / closed the alert comes from audit_logs.
func queryAlerts(ctx context.Context, tx pgx.Tx, where string, args ...any) ([]Alert, error) {
	rows, err := tx.Query(ctx, `
		SELECT a.id::text, a.incident_id::text, a.camera_id::text, c.name, a.triggered_at, a.severity,
		       a.status, a.summary, a.snapshot_key, a.acknowledged_at, h.ack_by,
		       CASE WHEN h.reopened_at > h.closed_at THEN NULL ELSE h.closed_at END,
		       CASE WHEN h.reopened_at > h.closed_at THEN NULL ELSE h.closed_by END
		FROM alerts a
		LEFT JOIN cameras c ON c.id = a.camera_id
		LEFT JOIN LATERAL (
		    SELECT (array_agg(l.details->>'actor' ORDER BY l.created_at)
		                FILTER (WHERE l.action = 'alert.acknowledged'))[1] AS ack_by,
		           max(l.created_at) FILTER (WHERE l.action IN ('alert.resolved', 'alert.false_positive')) AS closed_at,
		           (array_agg(l.details->>'actor' ORDER BY l.created_at DESC)
		                FILTER (WHERE l.action IN ('alert.resolved', 'alert.false_positive')))[1] AS closed_by,
		           max(l.created_at) FILTER (WHERE l.action = 'alert.reopened') AS reopened_at
		    FROM audit_logs l
		    WHERE l.tenant_id = a.tenant_id AND l.target_type = 'alert' AND l.target_id = a.id
		) h ON true
		WHERE `+where+` ORDER BY a.triggered_at DESC LIMIT 200`, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Alert, error) {
		var a Alert
		err := r.Scan(&a.ID, &a.IncidentID, &a.CameraID, &a.CameraName, &a.TriggeredAt, &a.Severity,
			&a.Status, &a.Summary, &a.SnapshotKey, &a.AcknowledgedAt, &a.AcknowledgedBy, &a.ClosedAt, &a.ClosedBy)
		return a, err
	})
}

// Alerts lists the tenant's alerts, newest first; status "" means all.
func (s *Store) Alerts(ctx context.Context, status string) ([]Alert, error) {
	out := []Alert{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		list, err := queryAlerts(ctx, tx, `a.tenant_id = $1 AND ($2 = '' OR a.status = $2)`, tid, status)
		if err != nil {
			return err
		}
		out = list
		return nil
	})
	return out, err
}

// ReopenAlert undoes Resolve or False alarm: the alert gets back the status it had before
// (open or acknowledged), and after a false alarm its incident gets its status back too
// (from the audit log; for older records recovered if it has a recovery time, else
// unresolved).
func (s *Store) ReopenAlert(ctx context.Context, id, actor string) (*Alert, error) {
	var out *Alert
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var alertID, cameraID, current string
		var incidentID *string
		var ackAt *time.Time
		err := tx.QueryRow(ctx, `
			SELECT id::text, incident_id::text, camera_id::text, status, acknowledged_at FROM alerts
			WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, tid, id).Scan(&alertID, &incidentID, &cameraID, &current, &ackAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if current != "resolved" && current != "false_positive" {
			return ErrNotClosed
		}
		var prior, incidentPrior *string
		err = tx.QueryRow(ctx, `
			SELECT details->>'from', details->>'incident_from' FROM audit_logs
			WHERE tenant_id = $1 AND target_type = 'alert' AND target_id::text = $2 AND action = $3
			ORDER BY created_at DESC LIMIT 1`, tid, alertID, "alert."+current).Scan(&prior, &incidentPrior)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if incidentPrior != nil && *incidentPrior == "false_positive" {
			incidentPrior = nil // it was already marked: work it out instead
		}
		to := "open"
		if prior != nil && (*prior == "open" || *prior == "acknowledged") {
			to = *prior
		} else if ackAt != nil {
			to = "acknowledged"
		}
		if _, err := tx.Exec(ctx, `UPDATE alerts SET status = $3 WHERE tenant_id = $1 AND id::text = $2`, tid, alertID, to); err != nil {
			return err
		}
		message := "Resolve undone"
		if current == "false_positive" {
			message = "Not a false alarm (undone)"
			if incidentID != nil {
				if _, err := tx.Exec(ctx, `
					UPDATE incidents SET status = coalesce($3, CASE WHEN recovered_at IS NOT NULL THEN 'recovered' ELSE 'unresolved' END)
					WHERE tenant_id = $1 AND id::text = $2 AND status = 'false_positive'`, tid, *incidentID, incidentPrior); err != nil {
					return err
				}
			}
		}
		if err := audit(ctx, tx, tid, actor, "alert.reopened", "alert", alertID, map[string]any{
			"message": message, "from": current, "to": to, "incident_id": incidentID, "camera_id": cameraID,
		}); err != nil {
			return err
		}
		list, err := queryAlerts(ctx, tx, `a.id::text = $1`, alertID)
		if err == nil && len(list) == 1 {
			out = &list[0]
		}
		return err
	})
	return out, err
}

// SetAlertStatus moves an alert to acknowledged / resolved / false_positive and records
// who did it. A false positive also marks its incident false_positive.
func (s *Store) SetAlertStatus(ctx context.Context, id, status, actor string) (*Alert, error) {
	var out *Alert
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var alertID, cameraID, from string
		var incidentID *string
		err := tx.QueryRow(ctx, `
			SELECT id::text, incident_id::text, camera_id::text, status FROM alerts
			WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, tid, id).Scan(&alertID, &incidentID, &cameraID, &from)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if from != status { // repeating the same action changes and logs nothing
			var incidentFrom *string // kept so "not a false alarm" can restore it
			if status == "false_positive" && incidentID != nil {
				_ = tx.QueryRow(ctx, `SELECT status FROM incidents WHERE tenant_id = $1 AND id::text = $2`,
					tid, *incidentID).Scan(&incidentFrom)
			}
			var ack *time.Time
			if status == "acknowledged" {
				now := time.Now()
				ack = &now
			}
			if _, err := tx.Exec(ctx, `
				UPDATE alerts SET status = $3, acknowledged_at = coalesce(acknowledged_at, $4)
				WHERE tenant_id = $1 AND id::text = $2`, tid, alertID, status, ack); err != nil {
				return err
			}
			if err := audit(ctx, tx, tid, actor, "alert."+status, "alert", alertID, map[string]any{
				"message": AlertActionText[status], "from": from, "to": status,
				"incident_id": incidentID, "camera_id": cameraID, "incident_from": incidentFrom,
			}); err != nil {
				return err
			}
			if status == "false_positive" && incidentID != nil {
				if _, err := tx.Exec(ctx, `UPDATE incidents SET status = 'false_positive'
					WHERE tenant_id = $1 AND id::text = $2`, tid, *incidentID); err != nil {
					return err
				}
			}
		}
		list, err := queryAlerts(ctx, tx, `a.id::text = $1`, alertID)
		if err != nil {
			return err
		}
		if len(list) == 1 {
			out = &list[0]
		}
		return nil
	})
	return out, err
}
