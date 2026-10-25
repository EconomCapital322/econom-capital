package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	basecurve "github.com/mrsskaa/curves-module/base"
)

type request struct {
	Points []basecurve.RatePoint `json:"points"`
	Spec   basecurve.Spec        `json:"spec"`
}

func run(input io.Reader, output, diagnostics io.Writer) int {
	decoder := json.NewDecoder(input)
	decoder.DisallowUnknownFields()
	var data request
	err := decoder.Decode(&data)
	if err == nil {
		var extra json.RawMessage
		if next := decoder.Decode(&extra); !errors.Is(next, io.EOF) {
			err = errors.New("expected exactly one JSON request")
		}
	}
	if err != nil {
		fmt.Fprintln(diagnostics, "Invalid base curve request:", err)
		return 2
	}
	curve, err := basecurve.Build(data.Points, data.Spec)
	if err != nil {
		fmt.Fprintln(diagnostics, err)
		return 1
	}
	if err := json.NewEncoder(output).Encode(curve); err != nil {
		fmt.Fprintln(diagnostics, "Cannot encode base curve:", err)
		return 1
	}
	return 0
}

func main() {
	os.Exit(run(os.Stdin, os.Stdout, os.Stderr))
}
