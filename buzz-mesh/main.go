// buzz-mesh: Tailscale tsnet sidecar for Buzz Experimental P2P mode.
//
// Spawned by the Electron main process (src/main/p2p/mesh.ts).
// Joins the shared Buzz tailnet, then writes THREE lines to stdout:
//   1. The assigned Tailscale IP  (100.x.x.x)
//   2. The local HTTP API port    (integer)
//   3. The local SOCKS5 proxy port (integer)
//
// The SOCKS5 proxy routes TCP connections through the Tailscale network,
// allowing Node.js to reach other Buzz nodes' 100.x.x.x addresses.
//
// An inbound Tailscale listener on meshLibp2pPort forwards connections
// from the Tailscale network to Node.js libp2p on localhost:meshLibp2pPort.
//
// Local HTTP API (127.0.0.1:<apiPort>):
//   GET  /status   → {"state":"connected","ip":"100.x.x.x"}
//   GET  /peers    → ["100.x.x.x", ...] — other Buzz-mesh tailnet peers
//   GET  /shutdown → clean shutdown + exit 0
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
	"io"
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

// meshLibp2pPort is the fixed TCP port that libp2p listens on in Buzz Mesh mode,
// and the port that the Tailscale inbound forwarder bridges to.
const meshLibp2pPort = 14001

func main() {
	stateDir := flag.String("state-dir", "", "Directory to store Tailscale state (required)")
	authKey := flag.String("authkey", "", "Tailscale ephemeral preauth key (omit if state exists)")
	flag.Parse()

	if *stateDir == "" {
		log.Fatal("--state-dir is required")
	}

	// Generate a stable-looking hostname so multiple installs don't collide.
	hostname := fmt.Sprintf("buzz-%s", randomSuffix(8))

	srv := &tsnet.Server{
		Hostname: hostname,
		AuthKey:  *authKey,
		Dir:      *stateDir,
		Logf:     func(format string, args ...any) {},
	}
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

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

	// Start the SOCKS5 proxy: Node.js dials through this to reach 100.x.x.x peers.
	socksPort, err := startSocks5Proxy(ctx, srv)
	if err != nil {
		log.Fatalf("failed to start SOCKS5 proxy: %v", err)
	}

	// Start the Tailscale inbound forwarder: Tailscale :meshLibp2pPort → 127.0.0.1:meshLibp2pPort.
	go startTailscaleForwarder(ctx, srv)

	// Start the local HTTP control API.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("failed to bind local API listener: %v", err)
	}
	apiPort := ln.Addr().(*net.TCPAddr).Port

	// Announce: write IP, API port, and SOCKS5 port to stdout (one per line).
	// The Node.js parent reads these three lines to configure itself.
	fmt.Println(ip)
	fmt.Println(apiPort)
	fmt.Println(socksPort)

	shutdownCh := make(chan struct{})

	mux := http.NewServeMux()

	mux.HandleFunc("/status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"state": "connected", "ip": ip})
	})

	// /peers returns a JSON array of IPv4 addresses of other Buzz-mesh tailnet
	// peers discovered via the Tailscale LocalAPI. Node.js polls this to find
	// new peers to dial.
	mux.HandleFunc("/peers", func(w http.ResponseWriter, r *http.Request) {
		lc, err := srv.LocalClient()
		if err != nil {
			http.Error(w, "LocalClient unavailable", http.StatusInternalServerError)
			return
		}
		st, err := lc.Status(r.Context())
		if err != nil {
			http.Error(w, "Status unavailable", http.StatusInternalServerError)
			return
		}
		var ips []string
		for _, peer := range st.Peer {
			for _, addr := range peer.TailscaleIPs {
				if addr.Is4() {
					ips = append(ips, addr.String())
					break
				}
			}
		}
		if ips == nil {
			ips = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ips)
	})

	mux.HandleFunc("/shutdown", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
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

	select {
	case <-ctx.Done():
	case <-shutdownCh:
	}

	_ = httpServer.Close()
}

// startSocks5Proxy starts a SOCKS5 server on 127.0.0.1 with an OS-chosen port.
// All connections are routed through the tsnet server so they traverse the
// Tailscale VPN. Returns the port number.
func startSocks5Proxy(ctx context.Context, srv *tsnet.Server) (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	go func() {
		defer ln.Close()
		go func() { <-ctx.Done(); ln.Close() }()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handleSocks5(ctx, conn, srv)
		}
	}()
	return port, nil
}

// handleSocks5 implements a minimal SOCKS5 CONNECT handler (RFC 1928).
// Only IPv4 addresses are supported (sufficient for Tailscale 100.x.x.x).
func handleSocks5(ctx context.Context, client net.Conn, srv *tsnet.Server) {
	defer client.Close()

	buf := make([]byte, 258) // max SOCKS5 header size

	// ── Greeting ──────────────────────────────────────────────────────────────
	// Client sends: [VER=5, NMETHODS, METHOD...]
	if _, err := io.ReadFull(client, buf[:2]); err != nil || buf[0] != 5 {
		return
	}
	nMethods := int(buf[1])
	if _, err := io.ReadFull(client, buf[:nMethods]); err != nil {
		return
	}
	// Accept with NO_AUTH (0x00).
	if _, err := client.Write([]byte{5, 0}); err != nil {
		return
	}

	// ── Request ───────────────────────────────────────────────────────────────
	// Client sends: [VER=5, CMD=1(CONNECT), RSV=0, ATYP, ...]
	if _, err := io.ReadFull(client, buf[:4]); err != nil {
		return
	}
	if buf[0] != 5 || buf[1] != 1 {
		// Command not supported
		_, _ = client.Write([]byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}

	var target string
	switch buf[3] {
	case 1: // IPv4
		addr := make([]byte, 6) // 4 bytes IP + 2 bytes port
		if _, err := io.ReadFull(client, addr); err != nil {
			return
		}
		target = fmt.Sprintf("%d.%d.%d.%d:%d",
			addr[0], addr[1], addr[2], addr[3],
			int(addr[4])<<8|int(addr[5]))
	default:
		// Address type not supported
		_, _ = client.Write([]byte{5, 8, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}

	// Dial through the Tailscale VPN.
	upstream, err := srv.Dial(ctx, "tcp", target)
	if err != nil {
		_, _ = client.Write([]byte{5, 4, 0, 1, 0, 0, 0, 0, 0, 0}) // host unreachable
		return
	}
	defer upstream.Close()

	// Success reply: [VER=5, REP=0, RSV=0, ATYP=1, BND.ADDR(4), BND.PORT(2)]
	_, _ = client.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})

	// Bidirectional pipe.
	done := make(chan struct{}, 2)
	go func() { io.Copy(upstream, client); done <- struct{}{} }()
	go func() { io.Copy(client, upstream); done <- struct{}{} }()
	<-done
}

// startTailscaleForwarder listens on the Tailscale interface on meshLibp2pPort
// and forwards each accepted connection to localhost:meshLibp2pPort where
// Node.js libp2p is listening.
func startTailscaleForwarder(ctx context.Context, srv *tsnet.Server) {
	ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", meshLibp2pPort))
	if err != nil {
		log.Printf("[buzz-mesh] Tailscale forwarder listen error: %v", err)
		return
	}
	defer ln.Close()
	go func() { <-ctx.Done(); ln.Close() }()

	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go func(remote net.Conn) {
			defer remote.Close()
			local, err := net.DialTimeout("tcp",
				fmt.Sprintf("127.0.0.1:%d", meshLibp2pPort), 5*time.Second)
			if err != nil {
				return
			}
			defer local.Close()
			done := make(chan struct{}, 2)
			go func() { io.Copy(local, remote); done <- struct{}{} }()
			go func() { io.Copy(remote, local); done <- struct{}{} }()
			<-done
		}(conn)
	}
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
