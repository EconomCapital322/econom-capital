package logger_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"github.com/EconomCapital322/econom-capital/curves-module/stress/internal/config"
	"github.com/EconomCapital322/econom-capital/curves-module/stress/internal/logger"
)

func TestNewJSONLogger(t *testing.T) {
	var out bytes.Buffer
	log, err := logger.New(&out, slog.LevelInfo, config.LogFormatJSON)
	if err != nil {
		t.Fatal(err)
	}
	log.InfoContext(t.Context(), "calculation accepted", "run_id", "run-1")

	var record struct {
		Time    string `json:"time"`
		Level   string `json:"level"`
		Message string `json:"msg"`
		Service string `json:"service"`
		RunID   string `json:"run_id"`
	}
	decoder := json.NewDecoder(&out)
	if err := decoder.Decode(&record); err != nil {
		t.Fatalf("log is not valid JSON: %v", err)
	}
	if record.Time == "" || record.Level != "INFO" || record.Message != "calculation accepted" ||
		record.Service != "stress-service" || record.RunID != "run-1" {
		t.Fatalf("unexpected log record: %+v", record)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		t.Fatalf("unexpected trailing log output: %v", err)
	}
}

func TestNewLoggerFiltersLevels(t *testing.T) {
	levels := []slog.Level{slog.LevelDebug, slog.LevelInfo, slog.LevelWarn, slog.LevelError}
	for i, threshold := range levels {
		t.Run(threshold.String(), func(t *testing.T) {
			var out bytes.Buffer
			log, err := logger.New(&out, threshold, config.LogFormatJSON)
			if err != nil {
				t.Fatal(err)
			}
			for _, level := range levels {
				log.Log(t.Context(), level, level.String())
			}

			got := logMessages(t, &out)
			want := make([]string, 0, len(levels)-i)
			for _, level := range levels[i:] {
				want = append(want, level.String())
			}
			if !slices.Equal(got, want) {
				t.Fatalf("logged levels = %v, want %v", got, want)
			}
		})
	}
}

func logMessages(t *testing.T, in io.Reader) []string {
	t.Helper()
	var messages []string
	decoder := json.NewDecoder(in)
	for {
		var record struct {
			Message string `json:"msg"`
		}
		err := decoder.Decode(&record)
		if errors.Is(err, io.EOF) {
			return messages
		}
		if err != nil {
			t.Fatal(err)
		}
		messages = append(messages, record.Message)
	}
}

func TestNewTextLogger(t *testing.T) {
	var out bytes.Buffer
	log, err := logger.New(&out, slog.LevelInfo, config.LogFormatText)
	if err != nil {
		t.Fatal(err)
	}
	log.InfoContext(t.Context(), "started")
	for _, field := range []string{"level=INFO", "msg=started", "service=stress-service"} {
		if !strings.Contains(out.String(), field) {
			t.Errorf("log %q does not contain %q", out.String(), field)
		}
	}
}

func TestNewRejectsUnknownFormat(t *testing.T) {
	log, err := logger.New(io.Discard, slog.LevelInfo, "yaml")
	if err == nil || log != nil {
		t.Fatalf("New() = (%v, %v), want nil logger and an error", log, err)
	}
}
