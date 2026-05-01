# buzz-mesh — Tailscale tsnet sidecar for Buzz Experimental P2P
#
# Usage:
#   make all          Build all platform targets into dist/
#   make darwin-arm64
#   make darwin-amd64
#   make windows-amd64
#   make clean

BINARY  := buzz-mesh
DIST    := dist
MODULE  := buzz.app/mesh

.PHONY: all darwin-arm64 darwin-amd64 windows-amd64 clean

all: darwin-arm64 darwin-amd64 windows-amd64

darwin-arm64:
	@mkdir -p $(DIST)
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 \
		go build -ldflags="-s -w" -o $(DIST)/$(BINARY)-darwin-arm64 .

darwin-amd64:
	@mkdir -p $(DIST)
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 \
		go build -ldflags="-s -w" -o $(DIST)/$(BINARY)-darwin-amd64 .

windows-amd64:
	@mkdir -p $(DIST)
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
		go build -ldflags="-s -w" -o $(DIST)/$(BINARY)-windows-amd64.exe .

clean:
	rm -rf $(DIST)
