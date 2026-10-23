package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// queryAlerts runs an alert query; where is a condition on alias "a" using $1, $2, ...
func queryAlerts(ctx context.Context, tx pgx.Tx, where string, args ...any) ([]Alert, error) {
	rows, err := tx.Query(ctx, `
		SELECT a.id::text, a.incident_id::text, a.camera_id::text, c.name, a.triggered_at, a.severity,
		       a.status, a.summary, a.snapshot_key, a.acknowledged_at
		FROM alerts a LEFT JOIN cameras c ON c.id = a.camera_id
		WHERE `+where+` ORDER BY a.triggered_at DESC LIMIT 200`, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Alert, error) {
		var a Alert
		err := r.Scan(&a.ID, &a.IncidentID, &a.CameraID, &a.CameraName, &a.TriggeredAt, &a.Severity,
			&a.Status, &a.Summary, &a.SnapshotKey, &a.AcknowledgedAt)
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

// SetAlertStatus moves an alert to acknowledged / resolved / false_positive. A false
// positive also marks its incident false_positive.
func (s *Store) SetAlertStatus(ctx context.Context, id, status string) (*Alert, error) {
	var out *Alert
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var ack *time.Time
		if status == "acknowledged" {
			now := time.Now()
			ack = &now
		}
		tag, err := tx.Exec(ctx, `
			UPDATE alerts SET status = $3, acknowledged_at = coalesce(acknowledged_at, $4)
			WHERE tenant_id = $1 AND id::text = $2`, tid, id, status, ack)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		if status == "false_positive" {
			if _, err := tx.Exec(ctx, `UPDATE incidents SET status = 'false_positive'
				WHERE tenant_id = $1 AND id = (SELECT incident_id FROM alerts WHERE id::text = $2 LIMIT 1)`, tid, id); err != nil {
				return err
			}
		}
		list, err := queryAlerts(ctx, tx, `a.id::text = $1`, id)
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
