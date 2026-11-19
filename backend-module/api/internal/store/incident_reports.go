package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	// Deleted reports only: when, by whom, and when it will be removed for good.
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
	DeletedBy *string    `json:"deleted_by,omitempty"`
	PurgeAt   *time.Time `json:"purge_at,omitempty"`
}

// DefaultReportRetentionDays is how long a deleted report can be restored when the
// organization hasn't set report_retention_days.
const DefaultReportRetentionDays = 14

// retentionDays is the organization's report_retention_days, as SQL over tenants t.
var retentionDays = fmt.Sprintf(`coalesce(nullif(t.profile->>'report_retention_days', '')::int, %d)`, DefaultReportRetentionDays)

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
			WHERE r.tenant_id = $1 AND ($2 = '' OR r.incident_id::text = $2) AND r.deleted_at IS NULL
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
			WHERE r.tenant_id = $1 AND r.id::text = $2 AND r.deleted_at IS NULL`, tid, id), &out)
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
			WHERE r.tenant_id = $1 AND r.id::text = $2 AND r.deleted_at IS NULL RETURNING r.incident_id::text, old.status`,
			tid, id, title, content, status, actorID(ctx)).Scan(&incidentID, &before)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		action, msg := "incident.report_saved", "Incident report saved: "+title
		switch {
		case status == "final" && before != "final":
			msg = "Incident report finalized: " + title
		case status != "final" && before == "final":
			action, msg = "incident.report_reopened", "Incident report reopened as draft: "+title
		}
		return audit(ctx, tx, tid, actor, action, "incident", incidentID,
			map[string]any{"message": msg, "incident_id": incidentID, "report_id": id, "status": status})
	})
	if err != nil {
		return nil, err
	}
	return s.IncidentReport(ctx, id)
}

// DeleteIncidentReport moves a report to Recently deleted: it can be restored until the
// organization's report_retention_days pass, then PurgeDeletedReports removes it.
func (s *Store) DeleteIncidentReport(ctx context.Context, id, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var incidentID, title string
		err := tx.QueryRow(ctx, `UPDATE reports SET deleted_at = now(), deleted_by = $3
			WHERE tenant_id = $1 AND id::text = $2 AND deleted_at IS NULL RETURNING incident_id::text, title`,
			tid, id, actorID(ctx)).Scan(&incidentID, &title)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "incident.report_deleted", "incident", incidentID,
			map[string]any{"message": "Incident report deleted (restorable): " + title, "incident_id": incidentID, "report_id": id})
	})
}

// DeletedIncidentReports lists the reports that can still be restored, newest deletion first.
func (s *Store) DeletedIncidentReports(ctx context.Context) ([]IncidentReport, error) {
	out := []IncidentReport{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT `+reportColumns+`, c.name, i.started_at, r.deleted_at,
			  nullif(trim(coalesce(du.first_name, '') || ' ' || coalesce(du.last_name, '')), ''),
			  r.deleted_at + make_interval(days => `+retentionDays+`) `+reportJoins+`
			JOIN tenants t ON t.id = r.tenant_id
			LEFT JOIN users du ON du.id = r.deleted_by
			LEFT JOIN incidents i ON i.id = r.incident_id AND i.tenant_id = r.tenant_id
			LEFT JOIN cameras c ON c.id = i.camera_id
			WHERE r.tenant_id = $1 AND r.deleted_at IS NOT NULL
			ORDER BY r.deleted_at DESC LIMIT 500`, tid)
		if err != nil {
			return err
		}
		out, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (IncidentReport, error) {
			var rep IncidentReport
			err := scanReport(r, &rep, &rep.CameraName, &rep.StartedAt, &rep.DeletedAt, &rep.DeletedBy, &rep.PurgeAt)
			return rep, err
		})
		return err
	})
	return out, err
}

// RestoreIncidentReport brings a deleted report back.
func (s *Store) RestoreIncidentReport(ctx context.Context, id, actor string) (*IncidentReport, error) {
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var incidentID, title string
		err := tx.QueryRow(ctx, `UPDATE reports SET deleted_at = NULL, deleted_by = NULL
			WHERE tenant_id = $1 AND id::text = $2 AND deleted_at IS NOT NULL RETURNING incident_id::text, title`,
			tid, id).Scan(&incidentID, &title)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "incident.report_restored", "incident", incidentID,
			map[string]any{"message": "Incident report restored: " + title, "incident_id": incidentID, "report_id": id})
	})
	if err != nil {
		return nil, err
	}
	return s.IncidentReport(ctx, id)
}

// PurgeDeletedReports removes for good the reports deleted longer ago than their
// organization's report_retention_days. Returns how many were removed.
func (s *Store) PurgeDeletedReports(ctx context.Context) (int, error) {
	var tenants []string
	if err := s.plain(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id::text FROM tenants`)
		if err != nil {
			return err
		}
		tenants, err = pgx.CollectRows(rows, pgx.RowTo[string])
		return err
	}); err != nil {
		return 0, err
	}
	total := 0
	for _, t := range tenants {
		err := s.tx(WithTenant(ctx, t), func(tx pgx.Tx, tid string) error {
			rows, err := tx.Query(ctx, `DELETE FROM reports r USING tenants t
				WHERE t.id = r.tenant_id AND r.tenant_id = $1 AND r.deleted_at IS NOT NULL
				  AND r.deleted_at < now() - make_interval(days => `+retentionDays+`)
				RETURNING r.incident_id::text, r.id::text, r.title`, tid)
			if err != nil {
				return err
			}
			type gone struct{ incident, id, title string }
			removed, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (gone, error) {
				var g gone
				return g, r.Scan(&g.incident, &g.id, &g.title)
			})
			if err != nil {
				return err
			}
			for _, g := range removed {
				if err := audit(ctx, tx, tid, "System", "incident.report_purged", "incident", g.incident,
					map[string]any{"message": "Deleted incident report removed for good: " + g.title, "incident_id": g.incident, "report_id": g.id}); err != nil {
					return err
				}
			}
			total += len(removed)
			return nil
		})
		if err != nil {
			return total, err
		}
	}
	return total, nil
}
