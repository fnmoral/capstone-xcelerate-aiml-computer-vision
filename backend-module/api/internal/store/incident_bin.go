package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Fall event bin (super admins). A fall event moved to the bin (incidents.deleted_at) is
// hidden everywhere: Fall Events, alerts and notifications, analytics, reports and export,
// incident reports, share links and the activity log. Its video, reports and logs are kept,
// and restoring it brings everything back. Deleting it permanently removes every record
// about it (the API also deletes its videos and snapshots from stream-hub).

func init() {
	migrations = append(migrations,
		`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`, // in the bin since
		`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS deleted_by TEXT`,        // who moved it there
	)
}

// ErrIncidentActive: a fall still in progress can't be deleted (the detector is updating it).
var ErrIncidentActive = errors.New("this fall is still in progress: wait until the person recovers, or resolve it or mark it a false alarm first")

// notBinned is an SQL condition: the fall event whose id is in column col (may be NULL) is
// not in the bin. Rows without a fall event pass.
func notBinned(col string) string {
	return fmt.Sprintf(`NOT EXISTS (SELECT 1 FROM incidents bi WHERE bi.id = %s AND bi.deleted_at IS NOT NULL)`, col)
}

// BinIncident moves a fall event of the current organization to the bin.
func (s *Store) BinIncident(ctx context.Context, id, actor string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var status string
		err := tx.QueryRow(ctx, `SELECT status FROM incidents WHERE tenant_id = $1 AND id::text = $2 AND deleted_at IS NULL FOR UPDATE`,
			tid, id).Scan(&status)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if status == "active" {
			return ErrIncidentActive
		}
		if _, err := tx.Exec(ctx, `UPDATE incidents SET deleted_at = now(), deleted_by = $3 WHERE tenant_id = $1 AND id::text = $2`,
			tid, id, actor); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "incident.binned", "incident", id,
			map[string]any{"message": "Fall event moved to the bin", "incident_id": id})
	})
}

// BinnedIncident is a fall event in the bin, for the super admins' list.
type BinnedIncident struct {
	ID         string    `json:"id"`
	OrgID      string    `json:"org_id"`
	OrgName    string    `json:"org_name"`
	CameraName *string   `json:"camera_name"`
	StartedAt  time.Time `json:"started_at"`
	Status     string    `json:"status"`
	Severity   string    `json:"severity"`
	Location   *string   `json:"location_label"`
	Snapshot   *string   `json:"snapshot_key"`
	HasVideo   bool      `json:"has_video"`
	Reports    int       `json:"reports"`
	DeletedAt  time.Time `json:"deleted_at"`
	DeletedBy  *string   `json:"deleted_by"`
}

// BinnedIncidents lists the fall events in the bin, in every organization (super admins).
func (s *Store) BinnedIncidents(ctx context.Context) ([]BinnedIncident, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT i.id::text, t.id::text, t.name, c.name, i.started_at, i.status, i.severity, i.location_label,
		       i.snapshot_key, i.clip_key IS NOT NULL,
		       (SELECT count(*) FROM reports r WHERE r.tenant_id = i.tenant_id AND r.incident_id = i.id),
		       i.deleted_at, i.deleted_by
		FROM incidents i JOIN tenants t ON t.id = i.tenant_id
		LEFT JOIN cameras c ON c.id = i.camera_id
		WHERE i.deleted_at IS NOT NULL AND t.status = 'active'
		ORDER BY i.deleted_at DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (BinnedIncident, error) {
		var b BinnedIncident
		err := r.Scan(&b.ID, &b.OrgID, &b.OrgName, &b.CameraName, &b.StartedAt, &b.Status, &b.Severity, &b.Location,
			&b.Snapshot, &b.HasVideo, &b.Reports, &b.DeletedAt, &b.DeletedBy)
		return b, err
	})
}

// RestoreIncident takes a fall event (of any organization) out of the bin: it, its video,
// reports and logs are back where they were.
func (s *Store) RestoreIncident(ctx context.Context, id, actor string) error {
	return s.plain(ctx, func(tx pgx.Tx) error {
		var tid string
		err := tx.QueryRow(ctx, `UPDATE incidents SET deleted_at = NULL, deleted_by = NULL
			WHERE id::text = $1 AND deleted_at IS NOT NULL RETURNING tenant_id::text`, id).Scan(&tid)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tid); err != nil {
			return err
		}
		return audit(ctx, tx, tid, actor, "incident.restored", "incident", id,
			map[string]any{"message": "Fall event restored from the bin", "incident_id": id})
	})
}

// DeleteIncidentForever removes a fall event (of any organization; binned or not, but not
// one in progress) and every record about it: its cameras, detections, alerts and their
// notifications, incident reports, share links and activity log entries. It returns the
// media files to delete from stream-hub (clips and snapshots).
func (s *Store) DeleteIncidentForever(ctx context.Context, id, actor string) (clips, snapshots []string, err error) {
	err = s.plain(ctx, func(tx pgx.Tx) error {
		var tid, status, where string
		var clip, snap *string
		var started time.Time
		e := tx.QueryRow(ctx, `SELECT i.tenant_id::text, i.status, i.clip_key, i.snapshot_key, i.started_at,
			coalesce(nullif(i.location_label, ''), c.name, 'unknown camera')
			FROM incidents i LEFT JOIN cameras c ON c.id = i.camera_id WHERE i.id::text = $1 FOR UPDATE OF i`, id).
			Scan(&tid, &status, &clip, &snap, &started, &where)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if status == "active" {
			return ErrIncidentActive
		}
		if _, e := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tid); e != nil {
			return e
		}
		add := func(list *[]string, v *string) {
			if v != nil && *v != "" {
				*list = append(*list, *v)
			}
		}
		add(&clips, clip)
		add(&snapshots, snap)
		rows, e := tx.Query(ctx, `SELECT clip_key, snapshot_key FROM incident_cameras WHERE tenant_id::text = $1 AND incident_id::text = $2`, tid, id)
		if e != nil {
			return e
		}
		for rows.Next() {
			var c, sn *string
			if e := rows.Scan(&c, &sn); e != nil {
				rows.Close()
				return e
			}
			add(&clips, c)
			add(&snapshots, sn)
		}
		rows.Close()
		var alertIDs, reportIDs, linkIDs []string
		for _, q := range []struct {
			dst *[]string
			sql string
		}{
			{&alertIDs, `SELECT id::text FROM alerts WHERE tenant_id::text = $1 AND incident_id::text = $2`},
			{&reportIDs, `SELECT id::text FROM reports WHERE tenant_id::text = $1 AND incident_id::text = $2`},
			{&linkIDs, `SELECT id::text FROM shared_links WHERE tenant_id::text = $1 AND incident_id::text = $2`},
		} {
			r, e := tx.Query(ctx, q.sql, tid, id)
			if e != nil {
				return e
			}
			if *q.dst, e = pgx.CollectRows(r, pgx.RowTo[string]); e != nil {
				return e
			}
		}
		var alertSnaps []string
		if r, e := tx.Query(ctx, `SELECT snapshot_key FROM alerts WHERE id::text = ANY($1) AND snapshot_key IS NOT NULL`, alertIDs); e == nil {
			alertSnaps, _ = pgx.CollectRows(r, pgx.RowTo[string])
		}
		snapshots = append(snapshots, alertSnaps...)
		related := append(append(append([]string{id}, alertIDs...), reportIDs...), linkIDs...)
		for _, q := range []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM audit_logs WHERE tenant_id::text = $1 AND (target_id::text = ANY($2) OR details->>'incident_id' = $3
			   OR details->>'alert_id' = ANY($2) OR details->>'share_link_id' = ANY($2) OR details->>'report_id' = ANY($2))`, []any{tid, related, id}},
			{`DELETE FROM notification_deliveries WHERE tenant_id::text = $1 AND alert_id::text = ANY($2)`, []any{tid, alertIDs}},
			{`DELETE FROM notification_events WHERE tenant_id::text = $1 AND alert_id::text = ANY($2)`, []any{tid, alertIDs}},
			{`DELETE FROM alert_deliveries WHERE tenant_id::text = $1 AND alert_id::text = ANY($2)`, []any{tid, alertIDs}},
			{`DELETE FROM alerts WHERE tenant_id::text = $1 AND id::text = ANY($2)`, []any{tid, alertIDs}},
			{`DELETE FROM shared_links WHERE tenant_id::text = $1 AND incident_id::text = $2`, []any{tid, id}},
			{`DELETE FROM reports WHERE tenant_id::text = $1 AND incident_id::text = $2`, []any{tid, id}},
			{`DELETE FROM model_predictions WHERE tenant_id::text = $1 AND incident_id::text = $2`, []any{tid, id}},
			{`DELETE FROM incident_cameras WHERE tenant_id::text = $1 AND incident_id::text = $2`, []any{tid, id}},
			{`DELETE FROM incidents WHERE tenant_id::text = $1 AND id::text = $2`, []any{tid, id}},
		} {
			if _, e := tx.Exec(ctx, q.sql, q.args...); e != nil {
				return fmt.Errorf("%s: %w", q.sql[:40], e)
			}
		}
		// Accountability: who deleted which fall (not linked to it: nothing else is left).
		msg := fmt.Sprintf("Fall event deleted permanently: %s, fall on %s UTC", where, started.UTC().Format("2006-01-02 15:04"))
		if e := audit(ctx, tx, tid, actor, "incident.deleted_forever", "incident", "", map[string]any{"message": msg}); e != nil {
			return e
		}
		return platformLog(ctx, tx, actor, "incident.deleted_forever", tid, msg)
	})
	return clips, snapshots, err
}
