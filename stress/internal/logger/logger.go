package logger

import (
	"errors"
	"io"
	"log/slog"
	"strings"

	"github.com/mrsskaa/curves-module/stress/internal/config"
)

func New(
	out io.Writer,
	level slog.Level,
	format string,
) (*slog.Logger, error) {
	var handler slog.Handler

	switch strings.ToLower(format) {
	case config.LogFormatJSON:
		handler = slog.NewJSONHandler(out, &slog.HandlerOptions{
			Level: level,
		})

	case config.LogFormatText:
		handler = slog.NewTextHandler(out, &slog.HandlerOptions{
			Level: level,
		})

	default:
		return nil, errors.New("unknown log format")
	}

	logger := slog.New(handler)
	logger = logger.With("service", "stress-service")

	return logger, nil
}
