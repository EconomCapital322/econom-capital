package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/mrsskaa/curves-module/stress/internal/config"
	"github.com/mrsskaa/curves-module/stress/internal/httpapi"
	"github.com/mrsskaa/curves-module/stress/internal/logger"
	"github.com/mrsskaa/curves-module/stress/internal/server"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load config: %v", err) //nolint:errcheck

		return err
	}

	logger, err := logger.New(os.Stderr, cfg.LogLevel, cfg.LogFormat)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to create logger: %v", err) // nolint:errcheck

		return err
	}

	ctx, cancel := signal.NotifyContext(
		context.Background(),
		os.Interrupt, syscall.SIGTERM,
	)
	defer cancel()

	stressHandler := httpapi.NewHandler(logger)

	srv := server.New(cfg, stressHandler, logger)

	if err := srv.Run(ctx); err != nil {
		logger.Error("run server error", "error", err)

		return err
	}

	return nil
}
