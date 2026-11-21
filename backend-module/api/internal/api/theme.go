package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// saveDefaultTheme: {theme: "light" | "dark" | "system"}, the organization's default theme
// (people who picked their own theme keep it). Separate from PUT /settings, where a missing
// timezone means "each browser's own".
func (s *Server) saveDefaultTheme(c *gin.Context) {
	var in struct {
		Theme string `json:"theme"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || (in.Theme != "light" && in.Theme != "dark" && in.Theme != "system") {
		badRequest(c, "theme must be light, dark or system")
		return
	}
	if err := s.db.SetDefaultTheme(c.Request.Context(), in.Theme, actor(c)); err != nil {
		fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"theme": in.Theme})
}
