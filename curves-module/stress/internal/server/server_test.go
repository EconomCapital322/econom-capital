package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/mrsskaa/curves-module/stress/internal/config"
)

const testWaitTimeout = 5 * time.Second

func TestRunRejectsOccupiedPort(t *testing.T) {
	var lc net.ListenConfig
	listener, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := listener.Close(); err != nil {
			t.Error(err)
		}
	})
	cfg := testConfig(time.Second)
	cfg.HTTPAddr = listener.Addr().String()
	srv := New(cfg, http.NotFoundHandler(), discardLogger())

	err = srv.Run(t.Context())
	var opErr *net.OpError
	if !errors.As(err, &opErr) || opErr.Op != "listen" {
		t.Fatalf("Run() error = %v, want a listen error for the occupied port", err)
	}
}

func TestRunStopsOnContextCancellation(t *testing.T) {
	running := startServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), time.Second)
	response := <-requestAsync(t, running)
	if response.err != nil || response.status != http.StatusNoContent {
		t.Fatalf("initial request = %+v", response)
	}

	running.cancel()
	if err := running.wait(t); err != nil {
		t.Fatalf("Run() after cancellation: %v", err)
	}
	response = <-requestAsync(t, running)
	if response.err == nil {
		t.Fatal("server still accepted a request after Run returned")
	}
}

func TestRunShutdownWaitsForActiveRequest(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	writeResult := make(chan error, 1)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-release:
			_, err := io.WriteString(w, "finished")
			writeResult <- err
		case <-r.Context().Done():
			writeResult <- r.Context().Err()
		}
	})
	running := startServer(t, handler, 2*time.Second)
	t.Cleanup(unblock)
	shutdownStarted := make(chan struct{})
	running.server.httpServer.RegisterOnShutdown(func() { close(shutdownStarted) })
	response := requestAsync(t, running)
	waitSignal(t, started, "active request")

	running.cancel()
	waitSignal(t, shutdownStarted, "shutdown")
	select {
	case <-running.done:
		t.Fatalf("Run returned before the active request completed: %v", running.err)
	default:
	}
	unblock()

	got := <-response
	if got.err != nil || got.status != http.StatusOK || got.body != "finished" {
		t.Fatalf("active request did not finish normally: %+v", got)
	}
	if err := <-writeResult; err != nil {
		t.Fatalf("active handler was interrupted: %v", err)
	}
	if err := running.wait(t); err != nil {
		t.Fatalf("graceful Run() = %v, want nil", err)
	}
}

func TestRunShutdownTimeoutClosesActiveConnection(t *testing.T) {
	started := make(chan struct{})
	disconnected := make(chan struct{})
	handler := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(disconnected)
	})
	const shutdownTimeout = 50 * time.Millisecond
	running := startServer(t, handler, shutdownTimeout)
	response := requestAsync(t, running)
	waitSignal(t, started, "active request")

	beforeCancel := time.Now()
	running.cancel()
	err := running.wait(t)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run() = %v, want shutdown deadline exceeded", err)
	}
	if elapsed := time.Since(beforeCancel); elapsed < shutdownTimeout {
		t.Fatalf("connection closed after %s, before shutdown timeout %s", elapsed, shutdownTimeout)
	}
	waitSignal(t, disconnected, "forced connection close")
	if got := <-response; got.err == nil {
		t.Fatalf("unfinished request unexpectedly succeeded: %+v", got)
	}
}

type runningServer struct {
	server *Server
	cancel context.CancelFunc
	done   chan struct{}
	err    error // Written before closing done; read only after receiving from done.
	url    string
	client *http.Client
}

func startServer(t *testing.T, handler http.Handler, shutdownTimeout time.Duration) *runningServer {
	t.Helper()
	srv := New(testConfig(shutdownTimeout), handler, discardLogger())
	address := make(chan string, 1)
	// BaseContext exposes the actual ephemeral listener address without reserving and releasing a port.
	srv.httpServer.BaseContext = func(listener net.Listener) context.Context {
		address <- listener.Addr().String()
		return t.Context()
	}
	ctx, cancel := context.WithCancel(t.Context())
	running := &runningServer{
		server: srv, cancel: cancel, done: make(chan struct{}),
		client: &http.Client{
			Transport: &http.Transport{DisableKeepAlives: true},
			Timeout:   testWaitTimeout,
		},
	}
	t.Cleanup(func() {
		cancel()
		running.client.CloseIdleConnections()
		select {
		case <-running.done:
		case <-time.After(testWaitTimeout):
			if err := srv.httpServer.Close(); err != nil {
				t.Error(err)
			}
			t.Error("server did not stop during test cleanup")
		}
	})
	go func() {
		running.err = srv.Run(ctx)
		close(running.done)
	}()
	select {
	case addr := <-address:
		running.url = "http://" + addr
	case <-running.done:
		t.Fatalf("server exited before accepting connections: %v", running.err)
	case <-time.After(testWaitTimeout):
		t.Fatal("server did not start")
	}
	return running
}

func (r *runningServer) wait(t *testing.T) error {
	t.Helper()
	waitSignal(t, r.done, "server stop")
	return r.err
}

type requestResult struct {
	status int
	body   string
	err    error
}

func requestAsync(t *testing.T, running *runningServer) <-chan requestResult {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, running.url, nil)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan requestResult, 1)
	go func() {
		response, err := running.client.Do(request)
		if err != nil {
			result <- requestResult{err: err}
			return
		}
		body, readErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		result <- requestResult{
			status: response.StatusCode, body: string(body), err: errors.Join(readErr, closeErr),
		}
	}()
	return result
}

func waitSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(testWaitTimeout):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func testConfig(shutdownTimeout time.Duration) config.Config {
	return config.Config{
		HTTPAddr: "127.0.0.1:0", ReadHeaderTimeout: time.Second,
		ReadTimeout: testWaitTimeout, WriteTimeout: testWaitTimeout,
		IdleTimeout: time.Second, ShutdownTimeout: shutdownTimeout,
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
