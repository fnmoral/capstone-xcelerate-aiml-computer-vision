package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Incident is a fall incident with the cameras that saw it and its alert.
type Incident struct {
	ID              string           `json:"id"`
	CameraID        string           `json:"camera_id"`
	CameraName      *string          `json:"camera_name"`
	Zone            *string          `json:"zone"`
	StartedAt       time.Time        `json:"started_at"`
	RecoveredAt     *time.Time       `json:"recovered_at"`
	DurationSeconds *int             `json:"duration_seconds"`
	Status          string           `json:"status"`
	Severity        string           `json:"severity"`
	PeakConfidence  *float32         `json:"peak_confidence"`
	LocationLabel   *string          `json:"location_label"`
	SnapshotKey     *string          `json:"snapshot_key"`
	ClipKey         *string          `json:"clip_key"` // video of the main camera (clips/<incident>_<camera>.mp4)
	Notes           *string          `json:"notes"`     // single note field used before; also first in NoteList
	NoteList        []Note           `json:"note_list"` // all notes, oldest first
	Cameras         []IncidentCamera `json:"cameras"`
	Alert           *Alert           `json:"alert"`
}

// IncidentCamera is one camera (and tracked person) that saw an incident.
type IncidentCamera struct {
	CameraID    string    `json:"camera_id"`
	CameraName  *string   `json:"camera_name"`
	TrackID     int       `json:"track_id"`
	JoinedAt    time.Time `json:"joined_at"`
	SnapshotKey *string   `json:"snapshot_key"`
	ClipKey     *string   `json:"clip_key"` // this camera's video of the incident, once saved
}

// Alert is what staff act on.
type Alert struct {
	ID             string     `json:"id"`
	IncidentID     *string    `json:"incident_id"`
	CameraID       string     `json:"camera_id"`
	CameraName     *string    `json:"camera_name"`
	TriggeredAt    time.Time  `json:"triggered_at"`
	Severity       string     `json:"severity"`
	Status         string     `json:"status"`
	Summary        *string    `json:"summary"`
	SnapshotKey    *string    `json:"snapshot_key"`
	AcknowledgedAt *time.Time `json:"acknowledged_at"`
	AcknowledgedBy *string    `json:"acknowledged_by"`
	ClosedAt       *time.Time `json:"closed_at"` // resolved or marked a false alarm
	ClosedBy       *string    `json:"closed_by"`
}

// Prediction is one row of the ML output timeline.
type Prediction struct {
	At         time.Time       `json:"at"`
	CameraID   string          `json:"camera_id"`
	Label      string          `json:"label"`
	Confidence float32         `json:"confidence"`
	Output     json.RawMessage `json:"output"`
}

// IncidentFilter narrows the incident list. Empty strings and nil times mean "any".
type IncidentFilter struct {
	Status      string
	Severity    string
	CameraID    string // any camera that saw it
	Zone        string
	AlertStatus string     // open | acknowledged | resolved | false_positive | none (no alert)
	Since       *time.Time // started at or after
	Until       *time.Time // started before
	Limit       int        // default 100, at most 10000 (exports)
}

const incidentColumns = `
	i.id::text, i.camera_id::text, c.name, i.zone, i.started_at, i.recovered_at, i.duration_seconds,
	i.status, i.severity, i.peak_confidence, i.location_label, i.snapshot_key, i.clip_key, i.notes`

func scanIncident(r pgx.Row, inc *Incident) error {
	return r.Scan(&inc.ID, &inc.CameraID, &inc.CameraName, &inc.Zone, &inc.StartedAt, &inc.RecoveredAt,
		&inc.DurationSeconds, &inc.Status, &inc.Severity, &inc.PeakConfidence, &inc.LocationLabel,
		&inc.SnapshotKey, &inc.ClipKey, &inc.Notes)
}

// Incidents lists incidents, newest first.
func (s *Store) Incidents(ctx context.Context, f IncidentFilter) ([]Incident, error) {
	if f.Limit <= 0 {
		f.Limit = 100
	}
	if f.Limit > 10000 {
		f.Limit = 10000
	}
	out := []Incident{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `
			SELECT `+incidentColumns+`
			FROM incidents i LEFT JOIN cameras c ON c.id = i.camera_id
			WHERE i.tenant_id = $1
			  AND ($2 = '' OR i.status = $2)
			  AND ($3 = '' OR i.camera_id::text = $3
			       OR EXISTS (SELECT 1 FROM incident_cameras ic WHERE ic.incident_id = i.id AND ic.camera_id::text = $3))
			  AND ($4::timestamptz IS NULL OR i.started_at >= $4)
			  AND ($5::timestamptz IS NULL OR i.started_at < $5)
			  AND ($6 = '' OR i.severity = $6)
			  AND ($7 = '' OR i.zone = $7)
			  AND ($8 = ''
			       OR ($8 = 'none' AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.tenant_id = $1 AND a.incident_id = i.id))
			       OR EXISTS (SELECT 1 FROM alerts a WHERE a.tenant_id = $1 AND a.incident_id = i.id AND a.status = $8))
			ORDER BY i.started_at DESC LIMIT $9`,
			tid, f.Status, f.CameraID, f.Since, f.Until, f.Severity, f.Zone, f.AlertStatus, f.Limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var inc Incident
			if err := scanIncident(rows, &inc); err != nil {
				return err
			}
			out = append(out, inc)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if err := attachCameras(ctx, tx, out); err != nil {
			return err
		}
		return attachNotes(ctx, tx, tid, out)
	})
	return out, err
}

// Incident returns one incident with its cameras, alert and prediction timeline.
func (s *Store) Incident(ctx context.Context, id string) (*Incident, []Prediction, error) {
	var inc Incident
	preds := []Prediction{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		err := scanIncident(tx.QueryRow(ctx, `SELECT `+incidentColumns+`
			FROM incidents i LEFT JOIN cameras c ON c.id = i.camera_id
			WHERE i.tenant_id = $1 AND i.id::text = $2`, tid, id), &inc)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		list := []Incident{inc}
		if err := attachCameras(ctx, tx, list); err != nil {
			return err
		}
		if err := attachNotes(ctx, tx, tid, list); err != nil {
			return err
		}
		inc = list[0]

		rows, err := tx.Query(ctx, `
			SELECT predicted_at, camera_id::text, label, confidence, output
			FROM model_predictions
			WHERE tenant_id = $1 AND incident_id::text = $2
			ORDER BY predicted_at LIMIT 2000`, tid, id)
		if err != nil {
			return err
		}
		preds, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Prediction, error) {
			var p Prediction
			err := r.Scan(&p.At, &p.CameraID, &p.Label, &p.Confidence, &p.Output)
			return p, err
		})
		return err
	})
	if err != nil {
		return nil, nil, err
	}
	return &inc, preds, nil
}

// UpdateIncident sets the status (e.g. false_positive) and/or notes and records who did it.
func (s *Store) UpdateIncident(ctx context.Context, id string, status, notes *string, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var incID, cameraID, from string
		var oldNotes *string
		err := tx.QueryRow(ctx, `SELECT id::text, camera_id::text, status, notes FROM incidents
			WHERE tenant_id = $1 AND id::text = $2 FOR UPDATE`, tid, id).Scan(&incID, &cameraID, &from, &oldNotes)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE incidents SET status = coalesce($3, status), notes = coalesce($4, notes)
			WHERE tenant_id = $1 AND id::text = $2`, tid, incID, status, notes); err != nil {
			return err
		}
		ref := map[string]any{"incident_id": incID, "camera_id": cameraID}
		with := func(extra map[string]any) map[string]any {
			for k, v := range ref {
				extra[k] = v
			}
			return extra
		}
		if status != nil && *status != from {
			if err := audit(ctx, tx, tid, actor, "incident.status", "incident", incID, with(map[string]any{
				"message": "Incident status changed", "from": from, "to": *status,
			})); err != nil {
				return err
			}
		}
		if notes != nil && (oldNotes == nil || *oldNotes != *notes) {
			if err := audit(ctx, tx, tid, actor, "incident.notes", "incident", incID, with(map[string]any{
				"message": "Notes updated", "notes": *notes,
			})); err != nil {
				return err
			}
		}
		if status == nil || *status != "false_positive" {
			return nil
		}
		// Its open alerts become false alarms too, logged like the alert's own button.
		rows, err := tx.Query(ctx, `UPDATE alerts SET status = 'false_positive'
			WHERE tenant_id = $1 AND incident_id::text = $2 AND status <> 'false_positive'
			RETURNING id::text, camera_id::text`, tid, incID)
		if err != nil {
			return err
		}
		type changed struct{ id, camera string }
		list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (changed, error) {
			var c changed
			return c, r.Scan(&c.id, &c.camera)
		})
		if err != nil {
			return err
		}
		for _, a := range list {
			if err := audit(ctx, tx, tid, actor, "alert.false_positive", "alert", a.id, map[string]any{
				"message": AlertActionText["false_positive"], "to": "false_positive",
				"incident_id": incID, "camera_id": a.camera, "incident_from": from,
			}); err != nil {
				return err
			}
		}
		return nil
	})
}

// attachCameras fills Cameras and Alert for each incident in one round trip each.
func attachCameras(ctx context.Context, tx pgx.Tx, list []Incident) error {
	if len(list) == 0 {
		return nil
	}
	ids := make([]string, len(list))
	index := map[string]int{}
	for i := range list {
		ids[i] = list[i].ID
		index[list[i].ID] = i
		list[i].Cameras = []IncidentCamera{}
	}
	rows, err := tx.Query(ctx, `
		SELECT ic.incident_id::text, ic.camera_id::text, c.name, ic.track_id, ic.joined_at, ic.snapshot_key, ic.clip_key
		FROM incident_cameras ic LEFT JOIN cameras c ON c.id = ic.camera_id
		WHERE ic.incident_id::text = ANY($1::text[]) ORDER BY coalesce((c.metadata->>'sort_order')::int, 2147483647), ic.joined_at`, ids)
	if err != nil {
		return err
	}
	for rows.Next() {
		var incID string
		var ic IncidentCamera
		if err := rows.Scan(&incID, &ic.CameraID, &ic.CameraName, &ic.TrackID, &ic.JoinedAt, &ic.SnapshotKey, &ic.ClipKey); err != nil {
			rows.Close()
			return err
		}
		list[index[incID]].Cameras = append(list[index[incID]].Cameras, ic)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	alerts, err := queryAlerts(ctx, tx, `a.incident_id::text = ANY($1::text[])`, ids)
	if err != nil {
		return err
	}
	for i := range alerts {
		a := alerts[i]
		if a.IncidentID != nil {
			if j, ok := index[*a.IncidentID]; ok {
				list[j].Alert = &a
			}
		}
	}
	return nil
}
