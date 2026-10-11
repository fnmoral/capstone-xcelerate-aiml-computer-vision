package database

import (
	"fmt"

	_ "github.com/glebarez/go-sqlite"
	"github.com/jmoiron/sqlx"
)

func InitDB(dbPath string) (*sqlx.DB, error) {
	db, err := sqlx.Connect("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("ERROR to connect to DB SQLite: %w", err)
	}

	// Create manually db schema
	schema := `
	CREATE TABLE IF NOT EXISTS cameras (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		name TEXT NOT NULL,
		rtsp_url TEXT NOT NULL,
		username TEXT,
		password TEXT,
		status TEXT DEFAULT 'offline',
		created_at DATETIME NOT NULL,
		updated_at DATETIME NOT NULL
	);
	`

	_, err = db.Exec(schema)
	if err != nil {
		return nil, fmt.Errorf("Error creating the tables in the database: %w", err)
	}

	return db, nil
}
