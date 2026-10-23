package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Stats summarises incidents for the dashboard and the Analytics page.
type Stats struct {
	ActiveIncidents     int            `json:"active_incidents"`
	OpenAlerts          int            `json:"open_alerts"`
	IncidentsToday      int            `json:"incidents_today"`
	Incidents7d         int            `json:"incidents_7d"`
	AvgDownSeconds7d    *float64       `json:"avg_down_seconds_7d"`
	FalsePositives7d    int            `json:"false_positives_7d"`
	PerDay              []DayCount     `json:"per_day"`               // last 14 days, oldest first, zero-filled
	PerCamera           []CameraCount  `json:"per_camera"`            // last 30 days
	BySeverity          map[string]int `json:"by_severity"`           // last 30 days
	ByStatus            map[string]int `json:"by_status"`             // last 30 days
	PredictionsLastHour map[string]int `json:"predictions_last_hour"` // label -> count
}

// DayCount is the number of incidents on one day.
type DayCount struct {
	Day   string `json:"day"` // local date, YYYY-MM-DD
	Count int    `json:"count"`
}

// CameraCount is the number of incidents first seen by one camera.
type CameraCount struct {
	CameraID   string  `json:"camera_id"`
	CameraName *string `json:"camera_name"`
	Count      int     `json:"count"`
}

// Stats computes the dashboard numbers. "Today" and the days of PerDay start at midnight in
// tz (an IANA zone such as America/Toronto, from the browser; invalid or empty = UTC), so
// a fall at 9 pm doesn't count for the next day.
func (s *Store) Stats(ctx context.Context, tz string) (*Stats, error) {
	if _, err := time.LoadLocation(tz); err != nil || tz == "" {
		tz = "UTC"
	}
	st := &Stats{BySeverity: map[string]int{}, ByStatus: map[string]int{}, PredictionsLastHour: map[string]int{}}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		// date_trunc('day', ...) on timestamptz follows the session time zone.
		if _, err := tx.Exec(ctx, `SELECT set_config('TimeZone', $1, true)`, tz); err != nil {
			return err
		}
		err := tx.QueryRow(ctx, `
			SELECT
			  (SELECT count(*) FROM incidents WHERE tenant_id = $1 AND status = 'active'),
			  (SELECT count(*) FROM alerts    WHERE tenant_id = $1 AND status = 'open'),
			  (SELECT count(*) FROM incidents WHERE tenant_id = $1 AND started_at >= date_trunc('day', now())),
			  (SELECT count(*) FROM incidents WHERE tenant_id = $1 AND started_at >= now() - interval '7 days'
			                                    AND status <> 'false_positive'),
			  (SELECT avg(duration_seconds)::float8 FROM incidents WHERE tenant_id = $1
			      AND started_at >= now() - interval '7 days' AND duration_seconds IS NOT NULL
			      AND status <> 'false_positive'),
			  (SELECT count(*) FROM incidents WHERE tenant_id = $1 AND started_at >= now() - interval '7 days'
			                                    AND status = 'false_positive')`, tid).
			Scan(&st.ActiveIncidents, &st.OpenAlerts, &st.IncidentsToday, &st.Incidents7d,
				&st.AvgDownSeconds7d, &st.FalsePositives7d)
		if err != nil {
			return err
		}

		rows, err := tx.Query(ctx, `
			SELECT to_char(d.day, 'YYYY-MM-DD'), count(i.id)
			FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') AS d(day)
			LEFT JOIN incidents i ON i.tenant_id = $1 AND i.status <> 'false_positive'
			     AND i.started_at >= d.day AND i.started_at < d.day + interval '1 day'
			GROUP BY d.day ORDER BY d.day`, tid)
		if err != nil {
			return err
		}
		st.PerDay, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (DayCount, error) {
			var d DayCount
			err := r.Scan(&d.Day, &d.Count)
			return d, err
		})
		if err != nil {
			return err
		}

		rows, err = tx.Query(ctx, `
			SELECT i.camera_id::text, c.name, count(*)
			FROM incidents i LEFT JOIN cameras c ON c.id = i.camera_id
			WHERE i.tenant_id = $1 AND i.started_at >= now() - interval '30 days' AND i.status <> 'false_positive'
			GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`, tid)
		if err != nil {
			return err
		}
		st.PerCamera, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (CameraCount, error) {
			var c CameraCount
			err := r.Scan(&c.CameraID, &c.CameraName, &c.Count)
			return c, err
		})
		if err != nil {
			return err
		}

		for _, q := range []struct {
			sql string
			dst map[string]int
		}{
			{`SELECT severity, count(*) FROM incidents WHERE tenant_id = $1 AND started_at >= now() - interval '30 days'
			  AND status <> 'false_positive' GROUP BY 1`, st.BySeverity},
			{`SELECT status, count(*) FROM incidents WHERE tenant_id = $1 AND started_at >= now() - interval '30 days' GROUP BY 1`, st.ByStatus},
			{`SELECT label, count(*) FROM model_predictions WHERE tenant_id = $1 AND predicted_at >= now() - interval '1 hour' GROUP BY 1`,
				st.PredictionsLastHour},
		} {
			rows, err := tx.Query(ctx, q.sql, tid)
			if err != nil {
				return err
			}
			for rows.Next() {
				var k string
				var n int
				if err := rows.Scan(&k, &n); err != nil {
					rows.Close()
					return err
				}
				q.dst[k] = n
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}
		return nil
	})
	return st, err
}
