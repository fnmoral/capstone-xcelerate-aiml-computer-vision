package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Phone cameras send their video to the camera relay themselves (a phone streaming app such
// as Larix Broadcaster), from any network. Each one has a relay path (e.g. phone-3f9a...)
// and a random password; only the password's hash is stored, the app shows it once (as a
// QR code). The relay asks the API whether a phone may publish (RelayPublishAllowed).

// AddPhoneCamera records that a camera is a phone sending to the relay at path.
func (s *Store) AddPhoneCamera(ctx context.Context, cameraID, path, tokenHash string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		_, err := tx.Exec(ctx, `INSERT INTO phone_cameras (camera_id, tenant_id, path, token_hash, created_by)
			VALUES ($1, $2, $3, $4, $5)`, cameraID, tid, path, tokenHash, actorID(ctx))
		return err
	})
}

// RotatePhoneCamera gives a phone camera a new password (the old one stops working) and
// returns its relay path. ErrNotFound if the camera isn't a phone camera.
func (s *Store) RotatePhoneCamera(ctx context.Context, cameraID, tokenHash string) (string, error) {
	var path string
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		err := tx.QueryRow(ctx, `UPDATE phone_cameras SET token_hash = $3, rotated_at = now()
			WHERE camera_id = $1 AND tenant_id = $2 RETURNING path`, cameraID, tid, tokenHash).Scan(&path)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	})
	return path, err
}

// DeletePhoneCamera forgets a phone camera; its password stops working at once.
func (s *Store) DeletePhoneCamera(ctx context.Context, cameraID string) error {
	return s.tx(ctx, func(tx pgx.Tx, tid string) error {
		_, err := tx.Exec(ctx, `DELETE FROM phone_cameras WHERE camera_id = $1 AND tenant_id = $2`, cameraID, tid)
		return err
	})
}

// PhoneCameraIDs returns the organization's phone cameras (camera id -> true).
func (s *Store) PhoneCameraIDs(ctx context.Context) (map[string]bool, error) {
	out := map[string]bool{}
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		rows, err := tx.Query(ctx, `SELECT camera_id FROM phone_cameras WHERE tenant_id = $1`, tid)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		for _, id := range ids {
			out[id] = true
		}
		return err
	})
	return out, err
}

// RelayPublishAllowed reports whether tokenHash is the current password of the phone camera
// at path, and notes when it last connected. Called by the relay before any tenant is known.
func (s *Store) RelayPublishAllowed(ctx context.Context, path, tokenHash string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE phone_cameras SET last_publish_at = now()
		WHERE path = $1 AND token_hash = $2`, path, tokenHash)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}
