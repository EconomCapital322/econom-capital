package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

const validInput = `{"points":[{"tenor_years":"1","rate_percent":"2"},{"tenor_years":"3","rate_percent":"6"}],"spec":{"base_version":"linear-v1","stress_version":"example-stress-v1","method":"linear","day_count":"years","grid":[{"bucket_label":"2y","tenor_years":"2"}]}}`

func TestRun(t *testing.T) {
	var output, diagnostics bytes.Buffer
	if code := run(strings.NewReader(validInput), &output, &diagnostics); code != 0 {
		t.Fatalf("exit %d: %s", code, diagnostics.String())
	}
	var result struct {
		Code   string `json:"curve_code"`
		Points []struct {
			Rate         string `json:"rate_percent"`
			Interpolated bool   `json:"is_interpolated"`
			Extrapolated bool   `json:"is_extrapolated"`
		} `json:"points"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Code != "base" || len(result.Points) != 1 || result.Points[0].Rate != "4" || !result.Points[0].Interpolated || result.Points[0].Extrapolated {
		t.Fatalf("unexpected result: %s", output.String())
	}
}

func TestRunRejectsInvalidInput(t *testing.T) {
	for _, input := range []string{
		"", "{", "null", "{}", validInput + "{}",
		strings.Replace(validInput, `"points":`, `"unknown":1,"points":`, 1),
		strings.Replace(validInput, `"rate_percent":"2"`, `"rate_percent":2`, 1),
		strings.Replace(validInput, `"linear-v1"`, `"unsupported"`, 1),
	} {
		t.Run(input, func(t *testing.T) {
			var output, diagnostics bytes.Buffer
			if code := run(strings.NewReader(input), &output, &diagnostics); code == 0 || output.Len() != 0 || diagnostics.Len() == 0 {
				t.Fatal("invalid request must fail with diagnostics and no partial output")
			}
		})
	}
}
