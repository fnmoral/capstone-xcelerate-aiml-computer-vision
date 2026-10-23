package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

// LogEntry is one line of the activity log: something a person did (audit_logs) or a
// camera change the system noticed (system_logs, module 'camera').
type LogEntry struct {
	At         time.Time       `json:"at"`
	Kind       string          `json:"kind"`   // alert | incident | camera
	Action     string          `json:"action"` // e.g. alert.acknowledged, camera.paused, camera.not_working
	Actor      *string         `json:"actor"`  // null: noticed by the system
	CameraID   *string         `json:"camera_id"`
	CameraName *string         `json:"camera_name"`
	TargetID   *string         `json:"target_id"`
	IncidentID *string         `json:"incident_id"`
	Message    string          `json:"message"`
	Details    json.RawMessage `json:"details"`
}

// LogFilter narrows the activity log. Empty strings and nil times mean "any".
type LogFilter struct {
	Since, Until *time.Time
	Kind         string
	CameraID     string
	IncidentID   string
	Limit        int
}

// audit records a user action in audit_logs, inside the caller's transaction.
// details should carry "message" (shown in the log) and may carry camera_id,
// camera_name and incident_id so the log can be filtered and still reads well after
// the camera is removed.
func audit(ctx context.Context, tx pgx.Tx, tid, actor, action, targetType, targetID string, details map[string]any) error {
	if details == nil {
		details = map[string]any{}
	}
	details["actor"] = actor
	_, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (tenant_id, action, target_type, target_id, details)
		VALUES ($1, $2, $3, $4::uuid, $5)`, tid, action, targetType, targetID, details)
	return err
}

// Audit records a user action that isn't part of another store call (camera actions,
// which go through gateway-back first).
func (s *Store) Audit(ctx context.Context, actor, action, targetType, targetID string, details map[string]any) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		return audit(ctx, tx, tid, actor, action, targetType, targetID, details)
	})
}

// CameraEvent records a camera change the system noticed (stopped sending video, back
// online, paused from the gateway UI, ...) in system_logs. event becomes the log action
// "camera.<event>".
func (s *Store) CameraEvent(ctx context.Context, cameraID, cameraName, event, level, message string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		_, err := tx.Exec(ctx, `
			INSERT INTO system_logs (tenant_id, camera_id, module, level, message, context)
			VALUES ($1, $2::uuid, 'camera', $3, $4, $5)`, tid, cameraID, level, message,
			map[string]any{"event": event, "camera_name": cameraName})
		return err
	})
}

// Logs returns the activity log, newest first.
func (s *Store) Logs(ctx context.Context, f LogFilter) ([]LogEntry, error) {
	if f.Limit <= 0 {
		f.Limit = 200
	}
	if f.Limit > 10000 {
		f.Limit = 10000
	}
	out := []LogEntry{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `
			SELECT e.at, e.kind, e.action, e.actor, e.camera_id, coalesce(c.name, e.details->>'camera_name'),
			       e.target_id, e.incident_id, e.message, e.details
			FROM (
			    SELECT l.created_at AS at, l.target_type AS kind, l.action, l.details->>'actor' AS actor,
			           coalesce(l.details->>'camera_id', CASE WHEN l.target_type = 'camera' THEN l.target_id::text END) AS camera_id,
			           l.target_id::text AS target_id,
			           coalesce(l.details->>'incident_id', CASE WHEN l.target_type = 'incident' THEN l.target_id::text END) AS incident_id,
			           coalesce(l.details->>'message', l.action) AS message, l.details
			    FROM audit_logs l WHERE l.tenant_id = $1
			    UNION ALL
			    SELECT s.created_at, 'camera', 'camera.' || coalesce(s.context->>'event', 'status'), NULL,
			           s.camera_id::text, s.camera_id::text, NULL, s.message, s.context
			    FROM system_logs s WHERE s.tenant_id = $1 AND s.module = 'camera'
			) e
			LEFT JOIN cameras c ON c.id::text = e.camera_id
			WHERE ($2::timestamptz IS NULL OR e.at >= $2)
			  AND ($3::timestamptz IS NULL OR e.at < $3)
			  AND ($4 = '' OR e.kind = $4)
			  AND ($5 = '' OR e.camera_id = $5)
			  AND ($6 = '' OR e.incident_id = $6)
			ORDER BY e.at DESC LIMIT $7`, tid, f.Since, f.Until, f.Kind, f.CameraID, f.IncidentID, f.Limit)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (LogEntry, error) {
			var e LogEntry
			err := r.Scan(&e.At, &e.Kind, &e.Action, &e.Actor, &e.CameraID, &e.CameraName,
				&e.TargetID, &e.IncidentID, &e.Message, &e.Details)
			return e, err
		})
		return err
	})
	return out, err
}
