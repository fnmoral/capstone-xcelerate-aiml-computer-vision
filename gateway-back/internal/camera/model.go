package camera

import (
	"time"
)

type Camera struct {
	ID        string    `json:"id" db:"id"`
	TenantID  string    `json:"tenant_id" db:"tenant_id"`
	Name      string    `json:"name" db:"name"`
	RTSPURL   string    `json:"rtsp_url" db:"rtsp_url"`
	Username  string    `json:"username" db:"username"`
	Password  string    `json:"password" db:"password"`
	Status    string    `json:"status" db:"status"` // online, offline, error
	CreatedAt time.Time `json:"created_at" db:"created_at"`
	UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
}

type CreateCameraDTO struct {
	Name     string `json:"name" binding:"required"`
	RTSPURL  string `json:"rtsp_url" binding:"required,url"`
	Username string `json:"username"`
	Password string `json:"password"`
}
