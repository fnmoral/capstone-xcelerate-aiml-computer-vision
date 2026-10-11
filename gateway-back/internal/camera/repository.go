package camera

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/jmoiron/sqlx"
)

type Repository interface {
	Create(cam *Camera) error
	FindByID(id string) (*Camera, error)
	FindAll() ([]Camera, error)
	Count() (int64, error)
	Delete(id string) error
}

type sqliteRepository struct {
	db *sqlx.DB
}

func NewRepository(db *sqlx.DB) Repository {
	return &sqliteRepository{db: db}
}

func (r *sqliteRepository) Create(cam *Camera) error {
	query := `
		INSERT INTO cameras (id, tenant_id, name, rtsp_url, username, password, status, created_at, updated_at)
		VALUES (:id, :tenant_id, :name, :rtsp_url, :username, :password, :status, :created_at, :updated_at)
	`
	_, err := r.db.NamedExec(query, cam)
	if err != nil {
		return fmt.Errorf("Rrror executing insert query: %w", err)
	}
	return nil
}

func (r *sqliteRepository) FindByID(id string) (*Camera, error) {
	var cam Camera
	query := `
		SELECT id, tenant_id, name, rtsp_url, username, password, status, created_at, updated_at 
		FROM cameras 
		WHERE id = $1
	`
	err := r.db.Get(&cam, query, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("Error getting camera by ID: %w", err)
	}
	return &cam, nil
}

func (r *sqliteRepository) FindAll() ([]Camera, error) {
	var cameras []Camera
	query := `
		SELECT id, tenant_id, name, rtsp_url, username, password, status, created_at, updated_at 
		FROM cameras 
		ORDER BY created_at DESC
	`
	err := r.db.Select(&cameras, query)
	if err != nil {
		return nil, fmt.Errorf("Error getting camera list: %w", err)
	}
	return cameras, nil
}

func (r *sqliteRepository) Count() (int64, error) {
	var count int64
	query := `SELECT COUNT(*) FROM cameras`

	err := r.db.Get(&count, query)
	if err != nil {
		return 0, fmt.Errorf("Rrror counting camera records: %w", err)
	}
	return count, nil
}

func (r *sqliteRepository) Delete(id string) error {
	query := `DELETE FROM cameras WHERE id = $1`

	res, err := r.db.Exec(query, id)
	if err != nil {
		return fmt.Errorf("Rrror executing delete query: %w", err)
	}

	rowsAffected, _ := res.RowsAffected()
	if rowsAffected == 0 {
		return errors.New("No camera found to delete")
	}

	return nil
}
