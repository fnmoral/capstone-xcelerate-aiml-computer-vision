package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// IncidentReport is a filled-in incident report form (WSIB Form 7, OHSA notice, OSHA 301,
// internal) for one incident. Content holds the form's field values.
type IncidentReport struct {
	ID          string          `json:"id"`
	IncidentID  string          `json:"incident_id"`
	Form        string          `json:"form"`
	Status      string          `json:"status"` // draft | final
	Title       string          `json:"title"`
	Content     json.RawMessage `json:"content"`
	CreatedBy   *string         `json:"created_by"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	FinalizedBy *string         `json:"finalized_by"`
	FinalizedAt *time.Time      `json:"finalized_at"`
	CameraName  *string         `json:"camera_name,omitempty"`
	StartedAt   *time.Time      `json:"incident_started_at,omitempty"`
}

const reportColumns = `r.id::text, r.incident_id::text, r.form, r.status, r.title, r.content,
	nullif(trim(coalesce(cu.first_name, '') || ' ' || coalesce(cu.last_name, '')), ''), r.generated_at, r.updated_at,
	nullif(trim(coalesce(ru.first_name, '') || ' ' || coalesce(ru.last_name, '')), ''), r.reviewed_at`

const reportJoins = `FROM reports r LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users ru ON ru.id = r.reviewed_by`

func scanReport(r pgx.Row, out *IncidentReport, extra ...any) error {
	return r.Scan(append([]any{&out.ID, &out.IncidentID, &out.Form, &out.Status, &out.Title, &out.Content,
		&out.CreatedBy, &out.CreatedAt, &out.UpdatedAt, &out.FinalizedBy, &out.FinalizedAt}, extra...)...)
}

// IncidentReports lists reports, newest first; incidentID "" = every incident.
func (s *Store) IncidentReports(ctx context.Context, incidentID string) ([]IncidentReport, error) {
	out := []IncidentReport{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT `+reportColumns+`, c.name, i.started_at `+reportJoins+`
			LEFT JOIN incidents i ON i.id = r.incident_id AND i.tenant_id = r.tenant_id
			LEFT JOIN cameras c ON c.id = i.camera_id
			WHERE r.tenant_id = $1 AND ($2 = '' OR r.incident_id::text = $2)
			ORDER BY r.updated_at DESC LIMIT 500`, tid, incidentID)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (IncidentReport, error) {
			var rep IncidentReport
			err := scanReport(r, &rep, &rep.CameraName, &rep.StartedAt)
			return rep, err
		})
		return err
	})
	return out, err
}

// IncidentReport returns one report.
func (s *Store) IncidentReport(ctx context.Context, id string) (*IncidentReport, error) {
	var out IncidentReport
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		err := scanReport(tx.QueryRow(ctx, `SELECT `+reportColumns+` `+reportJoins+`
			WHERE r.tenant_id = $1 AND r.id::text = $2`, tid, id), &out)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	})
	return &out, err
}

// CreateIncidentReport saves a new draft report for an incident.
func (s *Store) CreateIncidentReport(ctx context.Context, incidentID, form, title string, content json.RawMessage, actor string) (*IncidentReport, error) {
	var id string
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM incidents WHERE tenant_id = $1 AND id::text = $2)`,
			tid, incidentID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		if err := tx.QueryRow(ctx, `INSERT INTO reports (tenant_id, incident_id, form, status, title, content, created_by)
			VALUES ($1, $2::uuid, $3, 'draft', $4, $5, $6) RETURNING id::text`,
			tid, incidentID, form, title, content, actorID(ctx)).Scan(&id); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "incident.report_created", "incident", incidentID,
			map[string]any{"message": "Incident report started: " + title, "incident_id": incidentID, "report_id": id, "form": form})
	})
	if err != nil {
		return nil, err
	}
	return s.IncidentReport(ctx, id)
}

// UpdateIncidentReport saves a report's fields and status (draft or final). A final
// report records who finalized it and when.
func (s *Store) UpdateIncidentReport(ctx context.Context, id, title, status string, content json.RawMessage, actor string) (*IncidentReport, error) {
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var incidentID, before string
		err := tx.QueryRow(ctx, `UPDATE reports r SET title = $3, content = $4, status = $5, updated_at = now(),
			  reviewed_by = CASE WHEN $5 = 'final' AND r.status <> 'final' THEN $6::uuid WHEN $5 <> 'final' THEN NULL ELSE r.reviewed_by END,
			  reviewed_at = CASE WHEN $5 = 'final' AND r.status <> 'final' THEN now() WHEN $5 <> 'final' THEN NULL ELSE r.reviewed_at END
			FROM (SELECT status FROM reports WHERE tenant_id = $1 AND id::text = $2) old
			WHERE r.tenant_id = $1 AND r.id::text = $2 RETURNING r.incident_id::text, old.status`,
			tid, id, title, content, status, actorID(ctx)).Scan(&incidentID, &before)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		msg := "Incident report saved: " + title
		if status == "final" && before != "final" {
			msg = "Incident report finalized: " + title
		}
		return audit(ctx, tx, tid, actor, "incident.report_saved", "incident", incidentID,
			map[string]any{"message": msg, "incident_id": incidentID, "report_id": id, "status": status})
	})
	if err != nil {
		return nil, err
	}
	return s.IncidentReport(ctx, id)
}

// DeleteIncidentReport removes a report.
func (s *Store) DeleteIncidentReport(ctx context.Context, id, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var incidentID, title string
		err := tx.QueryRow(ctx, `DELETE FROM reports WHERE tenant_id = $1 AND id::text = $2 RETURNING incident_id::text, title`,
			tid, id).Scan(&incidentID, &title)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "incident.report_deleted", "incident", incidentID,
			map[string]any{"message": "Incident report deleted: " + title, "incident_id": incidentID, "report_id": id})
	})
}
