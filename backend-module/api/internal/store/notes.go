package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Note is one entry in an incident's notes: who wrote what, when. Notes are append-only
// (audit_logs, action 'incident.note'), so several people can add them and none is lost.
type Note struct {
	At     time.Time `json:"at"`
	Author string    `json:"author"`
	Text   string    `json:"text"`
}

// AddNote appends a note to an incident.
func (s *Store) AddNote(ctx context.Context, incidentID, author, text string) (*Note, error) {
	var note *Note
	err := s.tx(ctx, func(tx pgx.Tx, tid string) error {
		var id, cameraID string
		err := tx.QueryRow(ctx, `SELECT id::text, camera_id::text FROM incidents WHERE tenant_id = $1 AND id::text = $2`,
			tid, incidentID).Scan(&id, &cameraID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := audit(ctx, tx, tid, author, "incident.note", "incident", id, map[string]any{
			"message": "Note added", "text": text, "incident_id": id, "camera_id": cameraID,
		}); err != nil {
			return err
		}
		note = &Note{At: time.Now(), Author: author, Text: text}
		return nil
	})
	return note, err
}

// attachNotes fills Notes for each incident, oldest first. The incidents.notes column
// (the single note field used before) shows as the first note, by "Earlier note".
func attachNotes(ctx context.Context, tx pgx.Tx, tid string, list []Incident) error {
	if len(list) == 0 {
		return nil
	}
	ids := make([]string, len(list))
	index := map[string]int{}
	for i := range list {
		ids[i] = list[i].ID
		index[list[i].ID] = i
		list[i].NoteList = []Note{}
		if list[i].Notes != nil && *list[i].Notes != "" {
			list[i].NoteList = append(list[i].NoteList, Note{At: list[i].StartedAt, Author: "Earlier note", Text: *list[i].Notes})
		}
	}
	rows, err := tx.Query(ctx, `
		SELECT target_id::text, created_at, coalesce(details->>'actor', ''), coalesce(details->>'text', '')
		FROM audit_logs
		WHERE tenant_id = $1 AND action = 'incident.note' AND target_id::text = ANY($2::text[])
		ORDER BY created_at`, tid, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var incID string
		var n Note
		if err := rows.Scan(&incID, &n.At, &n.Author, &n.Text); err != nil {
			return err
		}
		list[index[incID]].NoteList = append(list[index[incID]].NoteList, n)
	}
	return rows.Err()
}
