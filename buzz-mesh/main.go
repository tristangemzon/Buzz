// buzz-mesh: Tailscale tsnet sidecar for Buzz Experimental P2P mode.
//
// Spawned by the Electron main process (src/main/p2p/mesh.ts).
// Joins the shared Buzz tailnet, then writes two lines to stdout:
//   1. The assigned Tailscale IP  (100.x.x.x)
//   2. The local HTTP API port    (integer)
//
// Local HTTP API (127.0.0.1:<port>):
//   GET /status   → {"state":"connected","ip":"100.x.x.x"}
//   GET /shutdown → clean shutdown + exit 0
//
// Flags:
//   --state-dir   Path to persist Tailscale state across launches.
//   --authkey     Ephemeral Tailscale preauth key (omit if state already exists).

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

func main() {
	stateDir := flag.String("state-dir", "", "Directory to store Tailscale state (required)")
	authKey := flag.String("authkey", "", "Tailscale ephemeral preauth key (omit if state exists)")
	flag.Parse()

	if *stateDir == "" {
		log.Fatal("--state-dir is required")
	}

	// Generate a stable-looking hostname derived from a random suffix so
	// multiple installs on the same tailnet don't collide.
	hostname := fmt.Sprintf("buzz-%s", randomSuffix(8))

	srv := &tsnet.Server{
		Hostname: hostname,
		AuthKey:  *authKey,
		Dir:      *stateDir,
		// Silence tsnet's internal logging — Electron doesn't need it and
		// it would pollute stderr with noise.
		Logf: func(format string, args ...any) {},
	}
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Handle SIGTERM / SIGINT for graceful shutdown.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigs
		cancel()
	}()

	// Connect to the tailnet. Up() blocks until the node has a Tailscale IP.
	status, err := srv.Up(ctx)
	if err != nil {
		log.Fatalf("tsnet Up failed: %v", err)
	}

	// Find the first IPv4 Tailscale address (100.x.x.x).
	ip := ""
	for _, addr := range status.TailscaleIPs {
		if addr.Is4() {
			ip = addr.String()
			break
		}
	}
	if ip == "" {
		log.Fatal("tsnet Up succeeded but no IPv4 address assigned")
	}

	// Start the local HTTP control API on 127.0.0.1 with OS-chosen port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("failed to bind local API listener: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	// Announce: write IP and port to stdout. The Node.js parent reads these.
	fmt.Println(ip)
	fmt.Println(port)

	shutdownCh := make(chan struct{})

	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"state": "connected",
			"ip":    ip,
		})
	})
	mux.HandleFunc("/shutdown", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
		// Signal shutdown after the response is flushed.
		go func() {
			time.Sleep(100 * time.Millisecond)
			close(shutdownCh)
		}()
	})

	httpServer := &http.Server{
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
	}

	go func() {
		if err := httpServer.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("local API error: %v", err)
		}
	}()

	// Block until SIGTERM or /shutdown.
	select {
	case <-ctx.Done():
	case <-shutdownCh:
	}

	_ = httpServer.Close()
}

func randomSuffix(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	b := make([]byte, n)
	for i := range b {
		b[i] = chars[r.Intn(len(chars))]
	}
	return string(b)
}
