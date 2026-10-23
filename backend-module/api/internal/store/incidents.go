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
	Notes           *string          `json:"notes"`
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
}

// Prediction is one row of the ML output timeline.
type Prediction struct {
	At         time.Time       `json:"at"`
	CameraID   string          `json:"camera_id"`
	Label      string          `json:"label"`
	Confidence float32         `json:"confidence"`
	Output     json.RawMessage `json:"output"`
}

// IncidentFilter narrows the incident list.
type IncidentFilter struct {
	Status   string
	CameraID string
	Since    *time.Time
	Limit    int
}

const incidentColumns = `
	i.id::text, i.camera_id::text, c.name, i.zone, i.started_at, i.recovered_at, i.duration_seconds,
	i.status, i.severity, i.peak_confidence, i.location_label, i.snapshot_key, i.notes`

func scanIncident(r pgx.Row, inc *Incident) error {
	return r.Scan(&inc.ID, &inc.CameraID, &inc.CameraName, &inc.Zone, &inc.StartedAt, &inc.RecoveredAt,
		&inc.DurationSeconds, &inc.Status, &inc.Severity, &inc.PeakConfidence, &inc.LocationLabel,
		&inc.SnapshotKey, &inc.Notes)
}

// Incidents lists incidents, newest first.
func (s *Store) Incidents(ctx context.Context, f IncidentFilter) ([]Incident, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
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
			ORDER BY i.started_at DESC LIMIT $5`, tid, f.Status, f.CameraID, f.Since, f.Limit)
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
		return attachCameras(ctx, tx, out)
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

// UpdateIncident sets the status (e.g. false_positive) and/or notes.
func (s *Store) UpdateIncident(ctx context.Context, id string, status, notes *string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		tag, err := tx.Exec(ctx, `
			UPDATE incidents SET status = coalesce($3, status), notes = coalesce($4, notes)
			WHERE tenant_id = $1 AND id::text = $2`, tid, id, status, notes)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		if status != nil && *status == "false_positive" {
			_, err = tx.Exec(ctx, `UPDATE alerts SET status = 'false_positive' WHERE tenant_id = $1 AND incident_id::text = $2`, tid, id)
		}
		return err
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
		SELECT ic.incident_id::text, ic.camera_id::text, c.name, ic.track_id, ic.joined_at, ic.snapshot_key
		FROM incident_cameras ic LEFT JOIN cameras c ON c.id = ic.camera_id
		WHERE ic.incident_id::text = ANY($1::text[]) ORDER BY ic.joined_at`, ids)
	if err != nil {
		return err
	}
	for rows.Next() {
		var incID string
		var ic IncidentCamera
		if err := rows.Scan(&incID, &ic.CameraID, &ic.CameraName, &ic.TrackID, &ic.JoinedAt, &ic.SnapshotKey); err != nil {
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
