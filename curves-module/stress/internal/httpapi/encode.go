package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

func writeJSON(
	w http.ResponseWriter,
	r *http.Request,
	status int,
	body any,
	logger *slog.Logger,
) {
	data, err := json.Marshal(body)
	if err != nil {
		logger.ErrorContext(
			r.Context(), "failed to encode JSON response",
			"error", err,
			"method", r.Method,
			"path", r.URL.Path,
		)

		status = http.StatusInternalServerError
		data = []byte(`
			{
				"code": "INTERNAL_ERROR",
				"message": "Failed to encode response",
				"details": []
			}
		`)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if _, err := w.Write(append(data, '\n')); err != nil {
		logger.ErrorContext(r.Context(), "failed to write JSON response",
			"error", err,
			"method", r.Method,
			"path", r.URL.Path,
			"status", status,
		)
	}

}
