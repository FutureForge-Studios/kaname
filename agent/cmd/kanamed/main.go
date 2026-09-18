package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/futureforge/kaname/agent/internal/config"
	"github.com/futureforge/kaname/agent/internal/enroll"
	"github.com/futureforge/kaname/agent/internal/providers"
	"github.com/futureforge/kaname/agent/internal/rpc"

	// Linking a provider package in is what makes it selectable; the
	// binary's provider set is decided here rather than by a switch.
	_ "github.com/futureforge/kaname/agent/internal/providers/sim"
)

/* ------------------------------------------------------------------ *
 * kanamed — the Kaname agent.
 *
 * Runs as root on a managed host, dials the control plane and serves an
 * enumerated verb list over one multiplexed socket. It binds no port,
 * accepts no shell string, and holds the only private key that proves
 * this machine's identity.
 * ------------------------------------------------------------------ */

// Set by the build: `-ldflags "-X main.version=<release>"`. A binary
// nobody stamped says so, rather than claiming to be a release it is
// not — the control plane compares this string against the manifest to
// decide whether an update landed.
var version = "0.0.0-dev"

const (
	metricsInterval = 15 * time.Second
	backoffBase     = time.Second
	backoffMax      = 60 * time.Second
	// A connection that lived this long counts as healthy, so the next
	// failure starts backing off from scratch instead of from the cap.
	backoffResetAfter = 60 * time.Second
)

func main() {
	if err := dispatch(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintf(os.Stderr, "kanamed: %v\n", err)
		os.Exit(1)
	}
}

func dispatch(args []string) error {
	command := "run"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command, args = args[0], args[1:]
	}

	switch command {
	case "run":
		return runAgent(args)
	case "enroll":
		return runEnroll(args)
	case "version":
		fmt.Printf("kanamed %s (protocol %d, %s, %s/%s)\n",
			version, rpc.ProtocolVersion, runtime.Version(), runtime.GOOS, runtime.GOARCH)
		return nil
	case "help":
		usage(os.Stdout)
		return nil
	default:
		usage(os.Stderr)
		return fmt.Errorf("unknown command %q", command)
	}
}

func usage(out *os.File) {
	fmt.Fprint(out, `kanamed — the Kaname agent

Usage:
  kanamed enroll --token <token> --url <control-plane-url> [--state-dir <dir>]
  kanamed run [--state-dir <dir>] [--simulate] [--log-level <level>]
  kanamed version

`)
}

/* ------------------------------- enroll ------------------------------ */

func runEnroll(args []string) error {
	flags := flag.NewFlagSet("enroll", flag.ContinueOnError)
	token := flags.String("token", "", "single-use enrollment token printed by the panel")
	controlPlane := flags.String("url", "", "control plane origin, e.g. https://panel.example.com")
	stateDir := flags.String("state-dir", config.DefaultStateDir(), "directory holding the agent's identity")
	logLevel := flags.String("log-level", "info", "trace, debug, info, warn or error")
	if err := flags.Parse(args); err != nil {
		return err
	}

	logger, err := newLogger(*logLevel)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := config.Open(*stateDir)
	if err != nil {
		return err
	}
	host, err := enroll.ProbeHost()
	if err != nil {
		return err
	}

	return enroll.Run(ctx, store, enroll.Options{
		Token:           *token,
		ControlPlaneURL: *controlPlane,
		AgentVersion:    version,
		Host:            host,
		Logger:          logger,
	})
}

/* --------------------------------- run ------------------------------- */

func runAgent(args []string) error {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	stateDir := flags.String("state-dir", config.DefaultStateDir(), "directory holding the agent's identity")
	simulate := flags.Bool("simulate", false, "serve a deterministic fake host instead of this machine")
	logLevel := flags.String("log-level", "info", "trace, debug, info, warn or error")
	if err := flags.Parse(args); err != nil {
		return err
	}

	// A fake fleet that can be mistaken for a real one is worse than no
	// fake fleet (KD-010).
	if *simulate && os.Getenv("KANAME_ENV") == "production" {
		return errors.New("--simulate refuses to run with KANAME_ENV=production")
	}

	logger, err := newLogger(*logLevel)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := config.Open(*stateDir)
	if err != nil {
		return err
	}
	if !store.Enrolled() {
		return fmt.Errorf("%w: run `kanamed enroll --token <token> --url <panel>` first (state dir: %s)",
			config.ErrNotEnrolled, store.Dir())
	}

	name := "linux"
	if *simulate {
		name = "sim"
	}
	provider, err := providers.New(ctx, name, providers.Options{
		AgentVersion: version,
		StateDir:     store.Dir(),
		Logger:       logger,
	})
	if err != nil {
		return err
	}
	defer provider.Close()

	capabilities := provider.Capabilities()
	registry := rpc.NewRegistry(rpc.NewCapabilityGate(capabilities))
	rpc.RegisterHandlers(registry, provider, store.Dir())

	tlsConfig, err := store.TLSConfig()
	if err != nil {
		return err
	}
	key, err := store.PrivateKey()
	if err != nil {
		return err
	}

	logger.Info("starting",
		"version", version,
		"server_id", store.State.ServerID,
		"provider", name,
		"capabilities", len(capabilities),
		"methods", len(registry.Names()),
		"connect_url", store.State.ConnectURL,
	)

	var attempt backoff
	for ctx.Err() == nil {
		host, err := provider.Host(ctx)
		if err != nil {
			return fmt.Errorf("read host identity: %w", err)
		}

		lived, err := session(ctx, provider, logger, rpc.Options{
			ServerID:        store.State.ServerID,
			ControlPlaneURL: store.State.ControlPlaneURL,
			ConnectURL:      store.State.ConnectURL,
			TLS:             tlsConfig,
			PrivateKey:      key,
			AgentVersion:    version,
			Capabilities:    capabilities,
			Host:            host,
			Registry:        registry,
			Logger:          logger,
		})
		if ctx.Err() != nil {
			break
		}
		if lived >= backoffResetAfter {
			attempt.reset()
		}

		delay := attempt.next()
		logger.Warn("disconnected", "error", err, "retry_in", delay.Round(time.Millisecond))
		select {
		case <-time.After(delay):
		case <-ctx.Done():
		}
	}

	logger.Info("stopped")
	return nil
}

// session holds one connection open until it fails or the process is
// asked to stop, and reports how long it lasted.
func session(ctx context.Context, provider providers.Provider, logger *slog.Logger, opts rpc.Options) (time.Duration, error) {
	started := time.Now()

	conn, err := rpc.Dial(ctx, opts)
	if err != nil {
		return time.Since(started), err
	}
	logger.Info("connected", "url", opts.ConnectURL)

	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	go func() {
		<-connCtx.Done()
		// Only a shutdown deserves a clean close frame; a dead socket is
		// already gone.
		if ctx.Err() != nil {
			conn.Close("agent shutting down")
		}
	}()
	go pushMetrics(connCtx, conn, provider, logger)
	go forwardEvents(connCtx, conn, provider)

	err = conn.Serve(connCtx)
	return time.Since(started), err
}

// forwardEvents relays the provider's state changes onto the socket, so
// the control plane learns a unit failed without polling for it.
func forwardEvents(ctx context.Context, conn *rpc.Conn, provider providers.Provider) {
	events := provider.Events()
	if events == nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			if err := conn.Emit(ctx, event.Topic, event.Data); err != nil {
				return
			}
		}
	}
}

// pushMetrics feeds the control plane's health axis. A host that cannot
// sample itself simply stops pushing rather than tearing the connection
// down: metrics are not why the socket exists.
func pushMetrics(ctx context.Context, conn *rpc.Conn, provider providers.Provider, logger *slog.Logger) {
	ticker := time.NewTicker(metricsInterval)
	defer ticker.Stop()

	for {
		sample, err := provider.System().Metrics(ctx)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, providers.ErrUnsupported) {
				return
			}
			logger.Warn("metrics sample failed", "error", err)
		} else if err := conn.Emit(ctx, rpc.TopicMetrics, sample); err != nil {
			return
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

/* ------------------------------- backoff ----------------------------- */

// backoff is exponential with full jitter, capped so a long outage still
// retries once a minute rather than drifting into hours.
type backoff struct {
	attempt int
}

func (b *backoff) next() time.Duration {
	window := backoffBase << min(b.attempt, 6)
	if window > backoffMax {
		window = backoffMax
	}
	b.attempt++
	return window/2 + time.Duration(rand.Int64N(int64(window/2)+1))
}

func (b *backoff) reset() {
	b.attempt = 0
}

/* -------------------------------- logging ---------------------------- */

func newLogger(level string) (*slog.Logger, error) {
	var parsed slog.Level
	switch strings.ToLower(level) {
	case "trace", "debug":
		parsed = slog.LevelDebug
	case "info":
		parsed = slog.LevelInfo
	case "warn", "warning":
		parsed = slog.LevelWarn
	case "error":
		parsed = slog.LevelError
	default:
		return nil, fmt.Errorf("unknown log level %q", level)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: parsed}))
	slog.SetDefault(logger)
	return logger, nil
}
