package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

var (
	errMultipleJSONValues = errors.New("multiple json values")
)

func decodeJSON(body io.Reader, dest any) error {
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(dest); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}

	var extra json.RawMessage
	err := decoder.Decode(&extra)

	if errors.Is(err, io.EOF) {
		return nil
	}

	if err != nil {
		return fmt.Errorf(
			"invalid data after JSON: %w",
			err,
		)
	}

	return errMultipleJSONValues
}
