package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func digest(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func serve(t *testing.T, body []byte, status int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestDownloadVerifiesTheDigest(t *testing.T) {
	payload := []byte("#!/bin/true\nthis is the new agent\n")
	server := serve(t, payload, http.StatusOK)
	dst := filepath.Join(t.TempDir(), "kanamed.new")

	if err := Download(context.Background(), server.Client(), server.URL, digest(payload), dst); err != nil {
		t.Fatalf("download: %v", err)
	}

	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("reading the download: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("downloaded %q, want %q", got, payload)
	}
}

func TestDownloadRefusesAMismatchedDigest(t *testing.T) {
	server := serve(t, []byte("something else entirely"), http.StatusOK)
	dst := filepath.Join(t.TempDir(), "kanamed.new")

	err := Download(context.Background(), server.Client(), server.URL, digest([]byte("expected")), dst)
	if !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("expected a digest mismatch, got %v", err)
	}

	// The whole point: nothing is left behind that could be swapped in.
	if _, statErr := os.Stat(dst); !os.IsNotExist(statErr) {
		t.Fatalf("the rejected download is still on disk at %s", dst)
	}
}

func TestDownloadRefusesAShortDigest(t *testing.T) {
	server := serve(t, []byte("payload"), http.StatusOK)
	err := Download(context.Background(), server.Client(), server.URL, "abc123", filepath.Join(t.TempDir(), "x"))
	if err == nil || !strings.Contains(err.Error(), "64-character") {
		t.Fatalf("expected a complaint about the digest length, got %v", err)
	}
}

func TestDownloadReportsAnHTTPFailure(t *testing.T) {
	server := serve(t, []byte("not found"), http.StatusNotFound)
	dst := filepath.Join(t.TempDir(), "kanamed.new")

	err := Download(context.Background(), server.Client(), server.URL, digest([]byte("x")), dst)
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("expected the status in the error, got %v", err)
	}
	if _, statErr := os.Stat(dst); !os.IsNotExist(statErr) {
		t.Fatalf("a failed download left a file at %s", dst)
	}
}

func TestSwapKeepsThePreviousBinary(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "kanamed")
	staged := filepath.Join(dir, "kanamed.new")
	backup := filepath.Join(dir, "state", "kanamed.previous")

	if err := os.WriteFile(binary, []byte("old build"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staged, []byte("new build"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := Swap(binary, staged, backup); err != nil {
		t.Fatalf("swap: %v", err)
	}

	current, _ := os.ReadFile(binary)
	if string(current) != "new build" {
		t.Fatalf("the binary is %q, want the new build", current)
	}

	previous, err := os.ReadFile(backup)
	if err != nil {
		t.Fatalf("the previous binary was not kept: %v", err)
	}
	if string(previous) != "old build" {
		t.Fatalf("the backup is %q, want the old build", previous)
	}

	// The staged file is consumed by the rename, so a second swap cannot
	// silently re-apply a stale download.
	if _, statErr := os.Stat(staged); !os.IsNotExist(statErr) {
		t.Fatalf("the staged file survived the swap")
	}
}

func TestSwapRefusesWhenThereIsNothingToBackUp(t *testing.T) {
	dir := t.TempDir()
	staged := filepath.Join(dir, "kanamed.new")
	if err := os.WriteFile(staged, []byte("new build"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := Swap(filepath.Join(dir, "missing"), staged, filepath.Join(dir, "backup"))
	if err == nil {
		t.Fatal("expected swapping over a binary that is not there to fail")
	}
}
