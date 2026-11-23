package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func newSigner(t *testing.T, key crypto.Signer) ssh.Signer {
	t.Helper()
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func newEd25519Signer(t *testing.T) ssh.Signer {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return newSigner(t, key)
}

// startSSHServer serves SSH handshakes (no client auth) with the given host
// keys on 127.0.0.1 and returns its host:port address.
func startSSHServer(t *testing.T, hostKeys ...ssh.Signer) string {
	t.Helper()
	config := &ssh.ServerConfig{NoClientAuth: true}
	for _, key := range hostKeys {
		config.AddHostKey(key)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				sconn, chans, reqs, err := ssh.NewServerConn(conn, config)
				if err != nil {
					return
				}
				defer sconn.Close()
				go ssh.DiscardRequests(reqs)
				for ch := range chans {
					_ = ch.Reject(ssh.Prohibited, "test server")
				}
			}()
		}
	}()
	return listener.Addr().String()
}

func writeKnownHosts(t *testing.T, lines ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func dialPinned(t *testing.T, knownHostsPath, addr string) error {
	t.Helper()
	callback, algorithms, err := pinnedHostKey(knownHostsPath, addr)
	if err != nil {
		return err
	}
	client, err := ssh.Dial("tcp", addr, &ssh.ClientConfig{
		User:              "root",
		HostKeyCallback:   callback,
		HostKeyAlgorithms: algorithms,
		Timeout:           10 * time.Second,
	})
	if err != nil {
		return err
	}
	return client.Close()
}

func TestPinnedHostKeyAcceptsTheKeyOnFile(t *testing.T) {
	hostKey := newEd25519Signer(t)
	addr := startSSHServer(t, hostKey)
	path := writeKnownHosts(t, knownhosts.Line([]string{knownhosts.Normalize(addr)}, hostKey.PublicKey()))

	if err := dialPinned(t, path, addr); err != nil {
		t.Fatalf("pinned key refused: %v", err)
	}
}

// The server also offers an ECDSA key, which Go's client would pick by
// default; the file holds only the ed25519 key, so the handshake must ask
// for that one.
func TestPinnedHostKeyAsksForTheKeyTypeOnFile(t *testing.T) {
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	edKey := newEd25519Signer(t)
	addr := startSSHServer(t, newSigner(t, ecKey), edKey)
	path := writeKnownHosts(t, knownhosts.Line([]string{knownhosts.Normalize(addr)}, edKey.PublicKey()))

	callback, algorithms, err := pinnedHostKey(path, addr)
	if err != nil {
		t.Fatal(err)
	}
	if len(algorithms) != 1 || algorithms[0] != ssh.KeyAlgoED25519 {
		t.Fatalf("host key algorithms = %v, want [%s]", algorithms, ssh.KeyAlgoED25519)
	}
	_ = callback
	if err := dialPinned(t, path, addr); err != nil {
		t.Fatalf("pinned ed25519 key refused: %v", err)
	}
}

func TestPinnedHostKeyRefusesAChangedKey(t *testing.T) {
	addr := startSSHServer(t, newEd25519Signer(t))
	path := writeKnownHosts(t, knownhosts.Line([]string{knownhosts.Normalize(addr)}, newEd25519Signer(t).PublicKey()))

	err := dialPinned(t, path, addr)
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("changed host key: err = %v, want a refusal", err)
	}
}

func TestPinnedHostKeyRefusesAnUnknownHost(t *testing.T) {
	addr := startSSHServer(t, newEd25519Signer(t))
	path := writeKnownHosts(t, knownhosts.Line([]string{"other.example"}, newEd25519Signer(t).PublicKey()))

	err := dialPinned(t, path, addr)
	if err == nil || !strings.Contains(err.Error(), "refusing an unknown host") {
		t.Fatalf("unknown host: err = %v, want a refusal", err)
	}
}

func TestPinnedHostKeyNeedsAKnownHostsFile(t *testing.T) {
	for _, path := range []string{"", filepath.Join(t.TempDir(), "missing")} {
		_, _, err := pinnedHostKey(path, "vps.example:22")
		if err == nil || !strings.Contains(err.Error(), "pin the VPS host key first") {
			t.Fatalf("known_hosts %q: err = %v, want the pin hint", path, err)
		}
	}
}
