package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// MLStatus is ml-service's latest status report (the ml_status table): what it runs and
// how fast, rewritten every 10 s. Payload is ml-service's detection_settings() as JSON.
type MLStatus struct {
	Payload   []byte
	UpdatedAt time.Time
}

// MLStatus returns ml-service's latest report, or nil if it has never reported.
// The table is platform-wide (no tenant_id), so it is read outside the tenant scope.
func (s *Store) MLStatus(ctx context.Context) (*MLStatus, error) {
	var payload string
	var st MLStatus
	err := s.pool.QueryRow(ctx, `SELECT payload::text, updated_at FROM ml_status WHERE service = 'ml-service'`).
		Scan(&payload, &st.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("ml_status: %w", err)
	}
	st.Payload = []byte(payload)
	return &st, nil
}

// RecentPeople returns, per camera, the people ml-service saw within the last `within`:
// its newest prediction for each tracked person, as {"track", "label", "confidence"}.
// ml-service writes one prediction per person per second, so a few seconds is enough.
func (s *Store) RecentPeople(ctx context.Context, within time.Duration) (map[string][]map[string]any, error) {
	out := map[string][]map[string]any{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `
			SELECT DISTINCT ON (camera_id, output->>'track_id')
			       camera_id::text, (output->>'track_id')::int, label, confidence
			FROM model_predictions
			WHERE tenant_id = $1 AND predicted_at > now() - make_interval(secs => $2)
			  AND output ? 'track_id'
			ORDER BY camera_id, output->>'track_id', predicted_at DESC`, tid, within.Seconds())
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var camera, label string
			var track int
			var confidence float32
			if err := rows.Scan(&camera, &track, &label, &confidence); err != nil {
				return err
			}
			out[camera] = append(out[camera], map[string]any{
				"track": track, "label": label, "confidence": math.Round(float64(confidence)*100) / 100,
			})
		}
		return rows.Err()
	})
	for _, people := range out {
		sort.Slice(people, func(i, j int) bool { return people[i]["track"].(int) < people[j]["track"].(int) })
	}
	return out, err
}
