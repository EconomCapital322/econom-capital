package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/mrsskaa/curves-module/stress/internal/config"
)

type Server struct {
	httpServer      *http.Server
	logger          *slog.Logger
	shutdownTimeout time.Duration
}

func New(
	cfg config.Config,
	handler http.Handler,
	logger *slog.Logger,
) *Server {
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
	}

	return &Server{
		httpServer:      server,
		logger:          logger,
		shutdownTimeout: cfg.ShutdownTimeout,
	}
}

func (s *Server) Run(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	var lc net.ListenConfig

	listener, err := lc.Listen(ctx, "tcp", s.httpServer.Addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	s.logger.Warn("started HTTP server", "addr", listener.Addr().String())

	ch := make(chan error, 1)

	go func() {
		defer close(ch)

		err := s.httpServer.Serve(listener)

		if !errors.Is(err, http.ErrServerClosed) {
			ch <- err
		}
	}()

	select {
	case err := <-ch:
		if err != nil {
			return fmt.Errorf("serve HTTP: %w", err)
		}

	case <-ctx.Done():
		s.logger.Warn("shutdown HTTP server")

		shutdownCtx, cancel := context.WithTimeout(
			context.WithoutCancel(ctx),
			s.shutdownTimeout,
		)
		defer cancel()

		if err := s.httpServer.Shutdown(shutdownCtx); err != nil {
			if closeErr := s.httpServer.Close(); closeErr != nil {
				s.logger.Error("failed to close server", "error", closeErr)
			}

			return fmt.Errorf("shutdown HTTP server: %w", err)
		}

		s.logger.Warn("HTTP server stopped")
	}

	return nil
}
