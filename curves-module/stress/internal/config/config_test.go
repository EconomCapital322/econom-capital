package config_test

import (
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/EconomCapital322/econom-capital/curves-module/stress/internal/config"
)

func TestLoadDefaultsWithoutDotenv(t *testing.T) {
	isolateConfig(t)

	got, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	want := config.Config{
		HTTPAddr: "127.0.0.1:8081", ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second,
		IdleTimeout: time.Minute, ShutdownTimeout: 10 * time.Second,
		LogLevel: slog.LevelInfo, LogFormat: config.LogFormatText,
	}
	if got != want {
		t.Fatalf("Load() = %+v, want %+v", got, want)
	}
}

func TestLoadDotenv(t *testing.T) {
	isolateConfig(t)
	writeDotenv(t, `STRESS_HTTP_ADDR=127.0.0.1:9090
STRESS_READ_HEADER_TIMEOUT=2s
STRESS_READ_TIMEOUT=7s
STRESS_WRITE_TIMEOUT=12s
STRESS_IDLE_TIMEOUT=25s
STRESS_SHUTDOWN_TIMEOUT=3s
STRESS_LOG_LEVEL=DEBUG
STRESS_LOG_FORMAT=json
`)

	got, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	want := config.Config{
		HTTPAddr: "127.0.0.1:9090", ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout: 7 * time.Second, WriteTimeout: 12 * time.Second,
		IdleTimeout: 25 * time.Second, ShutdownTimeout: 3 * time.Second,
		LogLevel: slog.LevelDebug, LogFormat: config.LogFormatJSON,
	}
	if got != want {
		t.Fatalf("Load() = %+v, want %+v", got, want)
	}
}

func TestLoadEnvironmentOverridesDotenv(t *testing.T) {
	isolateConfig(t)
	writeDotenv(t, "STRESS_HTTP_ADDR=127.0.0.1:9090\nSTRESS_LOG_LEVEL=DEBUG\nSTRESS_LOG_FORMAT=json\n")
	t.Setenv("STRESS_HTTP_ADDR", "127.0.0.1:8181")
	t.Setenv("STRESS_LOG_LEVEL", "ERROR")

	got, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.HTTPAddr != "127.0.0.1:8181" || got.LogLevel != slog.LevelError {
		t.Fatalf("environment did not override .env: %+v", got)
	}
	if got.LogFormat != config.LogFormatJSON {
		t.Fatalf("unoverridden .env value = %q, want json", got.LogFormat)
	}
}

func TestLoadRejectsMalformedDotenv(t *testing.T) {
	isolateConfig(t)
	writeDotenv(t, "STRESS_HTTP_ADDR=\"unterminated\n")

	_, err := config.Load()
	if err == nil || !strings.Contains(err.Error(), "failed to read .env file") {
		t.Fatalf("Load() error = %v, want malformed .env error", err)
	}
}

func TestLoadRejectsInvalidEnvironment(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
		want  string
	}{
		{name: "duration_without_unit", key: "STRESS_READ_TIMEOUT", value: "10", want: "READ_TIMEOUT"},
		{name: "invalid_duration", key: "STRESS_IDLE_TIMEOUT", value: "later", want: "IDLE_TIMEOUT"},
		{name: "empty_address", key: "STRESS_HTTP_ADDR", value: "", want: "HTTP_ADDR"},
		{name: "missing_port", key: "STRESS_HTTP_ADDR", value: "localhost", want: "HTTP_ADDR"},
		{name: "named_port", key: "STRESS_HTTP_ADDR", value: "127.0.0.1:http", want: "port"},
		{name: "zero_port", key: "STRESS_HTTP_ADDR", value: "127.0.0.1:0", want: "port"},
		{name: "negative_port", key: "STRESS_HTTP_ADDR", value: "127.0.0.1:-1", want: "port"},
		{name: "port_above_limit", key: "STRESS_HTTP_ADDR", value: "127.0.0.1:65536", want: "port"},
		{name: "invalid_log_format", key: "STRESS_LOG_FORMAT", value: "yaml", want: "LOG_FORMAT"},
		{name: "invalid_log_level", key: "STRESS_LOG_LEVEL", value: "TRACE", want: "LOG_LEVEL"},
		{name: "unsupported_numeric_log_level", key: "STRESS_LOG_LEVEL", value: "INFO+1", want: "LOG_LEVEL"},
		{name: "unknown_variable", key: "STRESS_UNKNOWN_FOR_TEST", value: "1", want: "STRESS_UNKNOWN_FOR_TEST"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			isolateConfig(t)
			t.Setenv(test.key, test.value)

			_, err := config.Load()
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Load() error = %v, want an error mentioning %q", err, test.want)
			}
		})
	}
}

func TestLoadRejectsNonPositiveTimeouts(t *testing.T) {
	keys := []string{
		"READ_HEADER_TIMEOUT", "READ_TIMEOUT", "WRITE_TIMEOUT", "IDLE_TIMEOUT", "SHUTDOWN_TIMEOUT",
	}
	for _, key := range keys {
		for _, value := range []string{"0s", "-1s"} {
			t.Run(key+"/"+value, func(t *testing.T) {
				isolateConfig(t)
				t.Setenv("STRESS_"+key, value)

				_, err := config.Load()
				if err == nil || !strings.Contains(err.Error(), key+" must be strictly positive") {
					t.Fatalf("Load() error = %v, want positive %s validation", err, key)
				}
			})
		}
	}
}

// These tests deliberately avoid t.Parallel: both cwd and the environment are process-wide.
func isolateConfig(t *testing.T) {
	t.Helper()
	t.Chdir(t.TempDir())

	keys := map[string]struct{}{"STRESS_UNKNOWN_FOR_TEST": {}}
	for _, key := range []string{
		"HTTP_ADDR", "READ_HEADER_TIMEOUT", "READ_TIMEOUT", "WRITE_TIMEOUT",
		"IDLE_TIMEOUT", "SHUTDOWN_TIMEOUT", "LOG_LEVEL", "LOG_FORMAT",
	} {
		// envconfig also accepts the unprefixed names from the explicit struct tags.
		keys[key] = struct{}{}
		keys["STRESS_"+key] = struct{}{}
	}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "STRESS_") {
			keys[key] = struct{}{}
		}
	}
	for key := range keys {
		// Register restoration before removing the variable; an empty value is not unset.
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}
}

func writeDotenv(t *testing.T, contents string) {
	t.Helper()
	if err := os.WriteFile(".env", []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
