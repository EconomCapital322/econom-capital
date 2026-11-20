package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"github.com/kelseyhightower/envconfig"
)

const (
	LogFormatText = "text"
	LogFormatJSON = "json"
)

type Config struct {
	HTTPAddr          string        `envconfig:"HTTP_ADDR" default:"127.0.0.1:8081"`
	ReadHeaderTimeout time.Duration `envconfig:"READ_HEADER_TIMEOUT" default:"5s"`
	ReadTimeout       time.Duration `envconfig:"READ_TIMEOUT" default:"10s"`
	WriteTimeout      time.Duration `envconfig:"WRITE_TIMEOUT" default:"30s"`
	IdleTimeout       time.Duration `envconfig:"IDLE_TIMEOUT" default:"60s"`
	ShutdownTimeout   time.Duration `envconfig:"SHUTDOWN_TIMEOUT" default:"10s"`
	LogLevel          slog.Level    `envconfig:"LOG_LEVEL" default:"INFO"`
	LogFormat         string        `envconfig:"LOG_FORMAT" default:"text"`
}

func Load() (Config, error) {
	if err := godotenv.Load(".env"); err != nil && !os.IsNotExist(err) {
		return Config{}, fmt.Errorf("failed to read .env file: %w", err)
	}

	var cfg Config

	if err := envconfig.Process("STRESS", &cfg); err != nil {
		return Config{}, fmt.Errorf("failed to process config: %w", err)
	}

	if err := envconfig.CheckDisallowed("STRESS", &cfg); err != nil {
		return Config{}, err
	}

	if err := validateConfig(cfg); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

func validateConfig(cfg Config) error {
	if err := validateHTTPAddr(cfg.HTTPAddr); err != nil {
		return err
	}

	if cfg.ReadHeaderTimeout <= 0 {
		return errors.New("READ_HEADER_TIMEOUT must be strictly positive")
	}

	if cfg.ReadTimeout <= 0 {
		return errors.New("READ_TIMEOUT must be strictly positive")
	}

	if cfg.WriteTimeout <= 0 {
		return errors.New("WRITE_TIMEOUT must be strictly positive")
	}
	if cfg.IdleTimeout <= 0 {
		return errors.New("IDLE_TIMEOUT must be strictly positive")
	}

	if cfg.ShutdownTimeout <= 0 {
		return errors.New("SHUTDOWN_TIMEOUT must be strictly positive")
	}

	logFormat := strings.ToLower(cfg.LogFormat)
	if logFormat != LogFormatText && logFormat != LogFormatJSON {
		return fmt.Errorf(
			"invalid LOG_FORMAT %q: must be either %q or %q",
			logFormat, LogFormatText, LogFormatJSON,
		)
	}

	if cfg.LogLevel != slog.LevelInfo && cfg.LogLevel != slog.LevelDebug &&
		cfg.LogLevel != slog.LevelWarn && cfg.LogLevel != slog.LevelError {
		return errors.New("LOG_LEVEL can be only INFO, DEBUG, WARN or ERROR")
	}

	return nil
}

func validateHTTPAddr(addr string) error {
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid HTTP_ADDR format: %w", err)
	}

	port, err := strconv.Atoi(portStr)
	if err != nil {
		return fmt.Errorf("port must be a number: %w", err)
	}

	if port < 1 || port > 65535 {
		return fmt.Errorf("port %d out of range (1-65535)", port)
	}

	return nil
}
