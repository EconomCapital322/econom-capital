package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/mrsskaa/curves-module/stress/internal/stress"
)

func NewHandler(logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc(
		"POST /internal/v1/stress-curves",
		func(w http.ResponseWriter, r *http.Request) {
			handleCalculate(w, r, logger)
		},
	)
	mux.HandleFunc(
		"GET /healthz",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		},
	)

	return mux
}

func handleCalculate(w http.ResponseWriter, r *http.Request, logger *slog.Logger) {
	var request CalculateRequest
	if err := decodeJSON(r.Body, &request); err != nil {
		status := http.StatusUnprocessableEntity
		apiErr := APIError{
			Code:    "VALIDATION_ERROR",
			Message: "Request fields have invalid types",
		}

		var syntaxErr *json.SyntaxError
		if errors.As(err, &syntaxErr) ||
			errors.Is(err, io.EOF) ||
			errors.Is(err, io.ErrUnexpectedEOF) ||
			errors.Is(err, errMultipleJSONValues) {
			status = http.StatusBadRequest
			apiErr = APIError{
				Code:    "INVALID_JSON",
				Message: "Request body must contain valid JSON",
			}
		}

		writeAPIError(w, r, status, apiErr, logger)

		return
	}

	base, parameters, err := validateAndConvert(request)
	if err != nil {
		details := getValidationErrorDetails(err)

		writeAPIError(
			w, r, http.StatusUnprocessableEntity,
			APIError{
				Code:    "VALIDATION_ERROR",
				Message: "Invalid calculation request",
				Details: details,
			}, logger,
		)

		return
	}

	curves, err := stress.Calculate(base, parameters)
	if err != nil {
		handleCalculateError(w, r, err, logger)

		return
	}

	response := calculateResponseFromDomain(curves, request)

	writeJSON(w, r, http.StatusOK, response, logger)
}
