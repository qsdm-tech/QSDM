package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudflare/circl/sign/mldsa/mldsa87"
)

// fakeRelease packages a tiny in-memory release server: latest.txt
// returns a fixed tag, MANIFEST.json describes one artifact for the
// configured (component/os/arch), and the artifact body is held in
// memory. Tests construct one per case; the server URL is the
// updater's BaseURL.
type fakeRelease struct {
	tag          string
	component    string
	goos         string
	goarch       string
	artifactBin  []byte
	overrideSHA  string // when non-empty, use a mismatching artifact hash
	unsigned     bool
	badSignature bool
	bom          bool
}

func newFakeRelease(t *testing.T, tag, component, goos, goarch string, body []byte) *httptest.Server {
	t.Helper()
	fr := &fakeRelease{
		tag:         tag,
		component:   component,
		goos:        goos,
		goarch:      goarch,
		artifactBin: body,
	}
	return httptest.NewServer(fr)
}

func (f *fakeRelease) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	base := "/" + f.tag + "/"
	switch r.URL.Path {
	case "/" + DefaultLatestPath:
		fmt.Fprintln(w, f.tag)
	case base + ManifestFileName:
		w.Header().Set("Content-Type", "application/json")
		w.Write(f.manifest())
	case base + ManifestFileName + ".sig":
		if f.unsigned {
			http.NotFound(w, r)
			return
		}
		sig := make([]byte, mldsa87.SignatureSize)
		if err := mldsa87.SignTo(fakeReleasePrivateKey, f.manifest(), nil, false, sig); err != nil {
			panic(err)
		}
		if f.badSignature {
			sig[0] ^= 1
		}
		fmt.Fprintln(w, hex.EncodeToString(sig))
	case base + "qsdmminer-" + f.goos + "-" + f.goarch:
		w.Write(f.artifactBin)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeRelease) manifest() []byte {
	sha := sha256.Sum256(f.artifactBin)
	shaHex := hex.EncodeToString(sha[:])
	if f.overrideSHA != "" {
		shaHex = f.overrideSHA
	}
	body := fmt.Sprintf(`{
	  "version": %q,
	  "components": [
	    {
	      "component": %q, "os": %q, "arch": %q,
	      "file": "qsdmminer-%s-%s",
	      "sizeBytes": %d, "sha256": %q
	    }
	  ]
	}`, f.tag, f.component, f.goos, f.goarch, f.goos, f.goarch, len(f.artifactBin), shaHex)
	if f.bom {
		body = string(utf8BOM) + body
	}
	return []byte(body)
}

var fakeReleasePublicKey, fakeReleasePrivateKey = mldsa87.NewKeyFromSeed(&[mldsa87.SeedSize]byte{1})

func mustNew(t *testing.T, cfg Config) *Updater {
	t.Helper()
	cfg.TrustedKeyFile = filepath.Join(t.TempDir(), "miner-release.pub")
	if err := os.WriteFile(cfg.TrustedKeyFile, []byte(hex.EncodeToString(fakeReleasePublicKey.Bytes())), 0o600); err != nil {
		t.Fatal(err)
	}
	u, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return u
}

func missingStageUpdater(t *testing.T) *Updater {
	t.Helper()
	return mustNew(t, Config{
		BaseURL: "https://unused.invalid", Component: "qsdmminer", GOOS: "linux", GOARCH: "amd64",
		CurrentVersion: "v1.0.0",
	})
}

func TestNew_RejectsZeroValueConfig(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
	}{
		{"missing BaseURL", Config{Component: "c", GOOS: "linux", GOARCH: "amd64", CurrentVersion: "v1"}},
		{"missing Component", Config{BaseURL: "x", GOOS: "linux", GOARCH: "amd64", CurrentVersion: "v1"}},
		{"missing GOOS", Config{BaseURL: "x", Component: "c", GOARCH: "amd64", CurrentVersion: "v1"}},
		{"missing GOARCH", Config{BaseURL: "x", Component: "c", GOOS: "linux", CurrentVersion: "v1"}},
		{"missing CurrentVersion", Config{BaseURL: "x", Component: "c", GOOS: "linux", GOARCH: "amd64"}},
		{"missing trusted key", Config{BaseURL: "x", Component: "c", GOOS: "linux", GOARCH: "amd64", CurrentVersion: "v1.0.0"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := New(tc.cfg); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("want ErrInvalidConfig, got %v", err)
			}
		})
	}
}

func TestCheckAndStage_DevSkipsEverything(t *testing.T) {
	u := mustNew(t, Config{
		BaseURL: "https://nope.invalid", Component: "qsdmminer",
		GOOS: "linux", GOARCH: "amd64", CurrentVersion: "dev",
	})
	res, err := u.CheckAndStage(context.Background())
	if !errors.Is(err, ErrCurrentVersionDev) {
		t.Fatalf("want ErrCurrentVersionDev, got %v", err)
	}
	if res.SkippedReason == "" {
		t.Fatal("want SkippedReason set on dev skip")
	}
	if res.Checked || res.Staged || res.UpToDate {
		t.Fatalf("dev path must not network: %+v", res)
	}
}

func TestCheckAndStage_UpToDate(t *testing.T) {
	srv := newFakeRelease(t, "v1.2.3+abc", "qsdmminer", "linux", "amd64", []byte("ignored"))
	defer srv.Close()
	u := mustNew(t, Config{
		BaseURL: srv.URL, Component: "qsdmminer",
		GOOS: "linux", GOARCH: "amd64", CurrentVersion: "v1.2.3+abc",
		StagePath: filepath.Join(t.TempDir(), "miner.next"),
	})
	res, err := u.CheckAndStage(context.Background())
	if err != nil {
		t.Fatalf("up-to-date: %v", err)
	}
	if !res.Checked || !res.UpToDate || res.Staged {
		t.Fatalf("want Checked && UpToDate && !Staged, got %+v", res)
	}
}

func TestCheckAndStage_StagesNewVersion(t *testing.T) {
	body := []byte("the-fake-binary-payload-bytes-go-here-12345678")
	srv := newFakeRelease(t, "v0.2.0+def", "qsdmminer", "linux", "amd64", body)
	defer srv.Close()
	stage := filepath.Join(t.TempDir(), "miner.next")
	u := mustNew(t, Config{
		BaseURL: srv.URL, Component: "qsdmminer",
		GOOS: "linux", GOARCH: "amd64", CurrentVersion: "v0.1.0+abc",
		StagePath: stage,
	})
	res, err := u.CheckAndStage(context.Background())
	if err != nil {
		t.Fatalf("stage: %v", err)
	}
	if !res.Staged || res.NewVersion != "v0.2.0+def" || res.SizeBytes != int64(len(body)) {
		t.Fatalf("unexpected result: %+v", res)
	}
	got, err := os.ReadFile(stage)
	if err != nil {
		t.Fatalf("staged file: %v", err)
	}
	if !bytesEq(got, body) {
		t.Fatalf("staged bytes != source body")
	}

	// Idempotency: second call must NOT re-download.
	res2, err := u.CheckAndStage(context.Background())
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if res2.Staged {
		t.Fatalf("second call re-staged; expected idempotent skip: %+v", res2)
	}
	if res2.SkippedReason == "" {
		t.Fatalf("second call should explain skip: %+v", res2)
	}
}

func TestCheckAndStage_SHA256Mismatch(t *testing.T) {
	body := []byte("the-fake-binary-payload-bytes")
	srv := httptest.NewServer(&fakeRelease{
		tag: "v0.3.0+xxx", component: "qsdmminer", goos: "linux", goarch: "amd64",
		artifactBin: body, overrideSHA: strings.Repeat("0", 64),
	})
	defer srv.Close()

	stage := filepath.Join(t.TempDir(), "miner.next")
	u := mustNew(t, Config{
		BaseURL: srv.URL, Component: "qsdmminer",
		GOOS: "linux", GOARCH: "amd64", CurrentVersion: "v0.0.1",
		StagePath: stage,
	})
	res, err := u.CheckAndStage(context.Background())
	if err == nil {
		t.Fatal("want error on sha mismatch, got nil")
	}
	if !errors.Is(err, ErrSHA256Mismatch) {
		t.Fatalf("want ErrSHA256Mismatch, got %v", err)
	}
	if res.Staged {
		t.Fatalf("stage flag should be false on mismatch")
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatalf("staged file should not exist after mismatch: stat err=%v", err)
	}
}

func TestCheckAndStage_ComponentNotFound(t *testing.T) {
	srv := newFakeRelease(t, "v0.4.0+yyy", "qsdmcli", "linux", "amd64", []byte("body"))
	defer srv.Close()
	u := mustNew(t, Config{
		BaseURL: srv.URL, Component: "qsdmminer", // mismatch — manifest only has qsdmcli
		GOOS: "linux", GOARCH: "amd64", CurrentVersion: "v0.0.1",
		StagePath: filepath.Join(t.TempDir(), "miner.next"),
	})
	_, err := u.CheckAndStage(context.Background())
	if !errors.Is(err, ErrComponentNotFound) {
		t.Fatalf("want ErrComponentNotFound, got %v", err)
	}
}

func TestLooksLikeTag(t *testing.T) {
	good := []string{"v1.0.0", "v0.0.0+ce21940", "v2.3.4-rc.1", "release_42"}
	bad := []string{"", "v1; rm -rf /", "v1\n2", "v1 v2", strings.Repeat("a", 200)}
	for _, g := range good {
		if !looksLikeTag(g) {
			t.Errorf("good tag %q rejected", g)
		}
	}
	for _, b := range bad {
		if looksLikeTag(b) {
			t.Errorf("bad tag %q accepted", b)
		}
	}
}

// TestCheckAndStage_ManifestWithBOM exercises the defensive
// utf8BOM strip we apply before json.Unmarshal. PowerShell 5.1's
// `Set-Content -Encoding UTF8` (used by build_release.ps1 in
// earlier revisions) emits a BOM that vanilla json.Unmarshal
// rejects. The fixed build script no longer emits one, but a
// self-hosted release host using PowerShell 5.1 + a different
// publishing pipeline could re-introduce the BOM, so the
// updater is BOM-tolerant by design.
func TestCheckAndStage_ManifestWithBOM(t *testing.T) {
	body := []byte("payload-bytes-go-here-test-the-bom-tolerance-path")
	stage := filepath.Join(t.TempDir(), "miner.next")
	srv := httptest.NewServer(&fakeRelease{
		tag: "v0.5.0+bom", component: "qsdmminer", goos: "linux", goarch: "amd64",
		artifactBin: body, bom: true,
	})
	defer srv.Close()
	u := mustNew(t, Config{
		BaseURL: srv.URL, Component: "qsdmminer",
		GOOS: "linux", GOARCH: "amd64", CurrentVersion: "v0.4.0",
		StagePath: stage,
	})
	res, err := u.CheckAndStage(context.Background())
	if err != nil {
		t.Fatalf("BOM-prefixed manifest must parse: %v", err)
	}
	if !res.Staged || res.NewVersion != "v0.5.0+bom" {
		t.Fatalf("unexpected: %+v", res)
	}
}

func TestApplyStaged_NoStaged(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "miner")
	stagePath := filepath.Join(dir, "miner.next")
	if err := missingStageUpdater(t).ApplyStaged(stagePath, exePath, []string{exePath}); !errors.Is(err, ErrNoStagedUpdate) {
		t.Fatalf("want ErrNoStagedUpdate, got %v", err)
	}
}

func TestApplyStagedIfPresent_NoStaged(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "miner")
	applied, err := missingStageUpdater(t).ApplyStagedIfPresent(exePath, []string{exePath})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if applied {
		t.Fatal("applied=true with no staged file present")
	}
}

func TestCheckAndStageRequiresSignedManifest(t *testing.T) {
	for _, tc := range []struct {
		name     string
		unsigned bool
		badSig   bool
	}{
		{"missing signature", true, false},
		{"invalid signature", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(&fakeRelease{
				tag: "v1.1.0", component: "qsdmminer", goos: "linux", goarch: "amd64",
				artifactBin: []byte("test artifact"), unsigned: tc.unsigned, badSignature: tc.badSig,
			})
			defer srv.Close()
			stage := filepath.Join(t.TempDir(), "miner.next")
			u := mustNew(t, Config{
				BaseURL: srv.URL, Component: "qsdmminer", GOOS: "linux", GOARCH: "amd64",
				CurrentVersion: "v1.0.0", StagePath: stage,
			})
			if _, err := u.CheckAndStage(context.Background()); err == nil {
				t.Fatal("unverified manifest produced an update")
			}
			if _, err := os.Stat(stage); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("unverified release wrote an artifact: %v", err)
			}
		})
	}
}

func TestApplyReverifiesSignedStaging(t *testing.T) {
	body := []byte("test artifact")
	srv := newFakeRelease(t, "v1.1.0", "qsdmminer", "linux", "amd64", body)
	defer srv.Close()
	executable := filepath.Join(t.TempDir(), "miner")
	stage := executable + ".next"
	u := mustNew(t, Config{
		BaseURL: srv.URL, Component: "qsdmminer", GOOS: "linux", GOARCH: "amd64",
		CurrentVersion: "v1.0.0", StagePath: stage,
	})
	if _, err := u.CheckAndStage(context.Background()); err != nil {
		t.Fatal(err)
	}
	verified, err := u.prepareVerifiedArtifact(stage, executable)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(verified)
	if err != nil || !bytesEq(got, body) {
		t.Fatalf("verified copy: %q, %v", got, err)
	}
	if err := os.WriteFile(stage, []byte("Test artifact"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := u.ApplyStaged(stage, executable, nil); !errors.Is(err, ErrSHA256Mismatch) {
		t.Fatalf("changed binary got %v, want ErrSHA256Mismatch", err)
	}
	if err := os.Remove(stage + ".auth"); err != nil {
		t.Fatal(err)
	}
	if _, err := u.prepareVerifiedArtifact(stage, executable); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing staged authorization got %v", err)
	}

	if _, err := u.CheckAndStage(context.Background()); err != nil {
		t.Fatal(err)
	}
	u.cfg.CurrentVersion = "v1.2.0"
	if _, err := u.prepareVerifiedArtifact(stage, executable); !errors.Is(err, ErrReleaseNotNewer) {
		t.Fatalf("signed older version got %v, want ErrReleaseNotNewer", err)
	}
}

func TestApplyRestoresOriginalIfReplacementCannotStart(t *testing.T) {
	srv := newFakeRelease(t, "v1.1.0", "qsdmminer", "linux", "amd64", []byte("not an executable"))
	defer srv.Close()
	executable := filepath.Join(t.TempDir(), "miner.exe")
	original := []byte("current miner")
	if err := os.WriteFile(executable, original, 0o755); err != nil {
		t.Fatal(err)
	}
	stage := executable + ".next"
	u := mustNew(t, Config{
		BaseURL: srv.URL, Component: "qsdmminer", GOOS: "linux", GOARCH: "amd64",
		CurrentVersion: "v1.0.0", StagePath: stage,
	})
	if _, err := u.CheckAndStage(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := u.ApplyStaged(stage, executable, nil); err == nil || !strings.Contains(err.Error(), "start new binary") {
		t.Fatalf("expected a start failure, got %v", err)
	}
	got, err := os.ReadFile(executable)
	if err != nil || !bytesEq(got, original) {
		t.Fatalf("restored executable: %q, %v", got, err)
	}
}

// --- helpers ---

func bytesEq(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
