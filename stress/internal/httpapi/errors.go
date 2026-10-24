package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/mrsskaa/curves-module/stress/internal/stress"
)

var (
	ErrInvalidBaseCurve  = errors.New("invalid base curve")
	ErrInvalidParameters = errors.New("invalid parameters")
)

type ErrorDetail struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

type APIError struct {
	Code      string        `json:"code"`
	Message   string        `json:"message"`
	Details   []ErrorDetail `json:"details"`
	CurveCode string        `json:"curve_code,omitempty"`
}

func writeAPIError(
	w http.ResponseWriter,
	r *http.Request,
	status int,
	body APIError,
	logger *slog.Logger,
) {
	if body.Details == nil {
		body.Details = []ErrorDetail{}
	}

	writeJSON(w, r, status, body, logger)
}

func getValidationErrorDetails(err error) []ErrorDetail {
	details := []ErrorDetail{}

	switch {
	case errors.Is(err, ErrInvalidBaseCurve):
		details = append(details, ErrorDetail{
			Field:  "base",
			Reason: "Check curve code, point values and provenance flags",
		})

	case errors.Is(err, ErrInvalidParameters):
		details = append(details, ErrorDetail{
			Field:  "parameters",
			Reason: "Check mode and P/K/D value",
		})
	}

	return details
}

func handleCalculateError(
	w http.ResponseWriter,
	r *http.Request,
	err error,
	logger *slog.Logger,
) {
	invalidInput := errors.Is(err, stress.ErrInvalidBaseCurve) ||
		errors.Is(err, stress.ErrInvalidBucketLabel) ||
		errors.Is(err, stress.ErrInvalidTenorYears) ||
		errors.Is(err, stress.ErrInvalidParameters)

	if invalidInput {
		writeAPIError(w, r, http.StatusUnprocessableEntity, APIError{
			Code:    "VALIDATION_ERROR",
			Message: "Invalid base curve or scenario parameters",
		}, logger)

		return
	}

	logger.ErrorContext(r.Context(), "stress calculation failed", "error", err)

	writeAPIError(w, r, http.StatusInternalServerError, APIError{
		Code:    "CALCULATION_FAILED",
		Message: "Stress calculation failed",
	}, logger)
}
