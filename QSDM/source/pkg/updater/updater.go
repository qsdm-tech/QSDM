// Package updater is the consumer-miner self-update client.
//
// Design in one paragraph: the miner polls
// https://qsdm.tech/releases/latest.txt every N hours; when the tag
// differs from the baked-in pkg/buildinfo.Version, the miner fetches
// MANIFEST.json, locates the binary for its (GOOS, GOARCH), streams
// it to disk while computing SHA-256, and verifies the digest against
// the signed manifest. On match, the new binary is staged at
// <currentExePath>.next. The miner does NOT auto-restart by default —
// the staged file is applied at next startup (the operator's nssm /
// systemd / manual restart). This is a deliberate two-step ritual:
// staging is safe (download + verify), applying mutates the on-disk
// binary and re-execs, which we only want to happen at a moment the
// operator chose.
//
// Security model:
//
//   - A locally provisioned ML-DSA-87 release key authenticates the
//     exact manifest bytes before the updater trusts an artifact.
//   - Apply verifies the staged manifest again and hashes the copy
//     that it promotes to the running executable.
//
// Usage from the miner:
//
//	cfg := updater.Config{
//	    BaseURL:        "https://qsdm.tech/releases",
//	    Component:      "qsdmminer",
//	    GOOS:           runtime.GOOS,
//	    GOARCH:         runtime.GOARCH,
//	    CurrentVersion: buildinfo.Version,
//	    TrustedKeyFile: "/etc/qsdm/miner-release.pub",
//	}
//	u, err := updater.New(cfg)
//	// Handle err before using u.
//	res, err := u.CheckAndStage(ctx)
//	if res.Staged { log.Printf("update %s staged at %s", res.NewVersion, res.StagedPath) }
//
// Then at startup, before the mining loop:
//
//	if applied, err := u.ApplyStagedIfPresent(...); applied {
//	    // process re-execs into the new binary; control never
//	    // returns here on the success path.
//	}
package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/cloudflare/circl/sign/mldsa/mldsa87"
	"golang.org/x/mod/semver"
)

// utf8BOM is the byte-order mark some Windows tooling (notably
// PowerShell 5.1's `Set-Content -Encoding UTF8`) silently prepends
// to text files. Go's encoding/json rejects it with the cryptic
// "invalid character 'ï'" error; we strip it here so the
// updater is forgiving of release-host tooling drift.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// Default endpoint paths under BaseURL. Operators running their own
// release host can override these — but every QSDM consumer install
// today points at qsdm.tech so the defaults are the correct
// production values.
const (
	DefaultLatestPath = "latest.txt"
	ManifestFileName  = "MANIFEST.json"
)

// Config drives a single Updater instance. Zero values are flagged
// in New() so a caller can't accidentally build an Updater that
// silently fetches from "" and "compares against ”".
type Config struct {
	// BaseURL is the prefix for the release-host URLs. Trailing
	// slash is stripped. Required.
	BaseURL string

	// LatestPath is the path under BaseURL whose body is the
	// current tag, terminated by an optional newline. Empty
	// falls back to DefaultLatestPath.
	LatestPath string

	// Component selects which row of MANIFEST.components is
	// considered. The consumer miner uses "qsdmminer";
	// auxiliary tools could use "qsdmcli" or "qsdm-attester".
	Component string

	// GOOS / GOARCH select the artifact within the chosen
	// component. These mirror runtime.GOOS / runtime.GOARCH;
	// callers usually wire them straight through.
	GOOS, GOARCH string

	// CurrentVersion is what we compare the fetched tag
	// against. Almost always pkg/buildinfo.Version. The
	// "dev" sentinel (un-injected developer build) skips
	// every check via SkipUpdates so a `go run` workflow
	// doesn't randomly start downloading prod releases.
	CurrentVersion string

	// HTTPClient bounds network I/O. Nil falls back to
	// http.DefaultClient with a 30s per-request timeout
	// applied via context — that is the same posture as
	// every other QSDM HTTP client in the tree.
	HTTPClient *http.Client

	// StagePath is the on-disk destination for a fresh
	// download before it replaces the running binary.
	// Empty falls back to <currentExePath>.next so the
	// operator can find it next to their existing exe.
	StagePath string

	// TrustedKeyFile holds a hex-encoded ML-DSA-87 release public key
	// installed by the operator independently of the update feed.
	TrustedKeyFile string

	// MaxArtifactBytes caps the streamed download so a
	// hostile or accidentally-huge MANIFEST entry can't
	// blow up disk. Default 256 MiB — current artifacts
	// are ~15 MiB, so 256 MiB is ~17x headroom.
	MaxArtifactBytes int64
}

// Updater is the public type. Constructed once and reused —
// CheckAndStage is safe for concurrent calls but typically only one
// goroutine drives it on a timer.
type Updater struct {
	cfg        Config
	releaseKey *mldsa87.PublicKey

	stageMu  sync.Mutex
	mu       sync.Mutex
	lastSeen string // most recent tag we successfully read from latest.txt
}

// Result is the structured outcome of a single CheckAndStage call.
// Tests assert on this rather than on log output.
type Result struct {
	// Checked is true when the updater talked to BaseURL
	// successfully (parsed latest.txt). Distinguishes a
	// transient network failure from "nothing to do".
	Checked bool

	// SkippedReason is non-empty when the updater chose
	// not to do anything (e.g. CurrentVersion=="dev",
	// remote tag matches local). Useful for logs.
	SkippedReason string

	// UpToDate is true when the remote tag equals
	// CurrentVersion — the success path of "we checked,
	// nothing to do".
	UpToDate bool

	// Staged is true when CheckAndStage downloaded a new
	// binary, verified its SHA-256, and wrote it to
	// StagedPath. Staged=true implies NewVersion and
	// StagedPath are populated.
	Staged bool

	// NewVersion is the tag of the staged release.
	NewVersion string

	// StagedPath is the on-disk path of the freshly
	// downloaded binary. Equal to Config.StagePath when
	// the caller supplied one, else <exePath>.next.
	StagedPath string

	// SHA256 is the verified hex digest of StagedPath.
	SHA256 string

	// SizeBytes is the verified size of the staged file.
	SizeBytes int64
}

// Manifest is the on-the-wire shape of MANIFEST.json. The actual
// release script writes a few fields the updater ignores ("builtAt",
// "goVersion", per-component "label"); we list every field we DO
// consume so json.DisallowUnknownFields could be added later if we
// wanted to fail loudly on schema drift.
type Manifest struct {
	Version    string              `json:"version"`
	Components []ManifestComponent `json:"components"`
}

// ManifestComponent is one row of Manifest.Components. Component
// + os + arch is the composite key the updater filters by.
type ManifestComponent struct {
	Component string `json:"component"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	File      string `json:"file"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

// Errors. Distinct types so callers can log or branch without
// substring-matching error strings.
var (
	ErrNoStagedUpdate    = errors.New("updater: no staged update file present")
	ErrComponentNotFound = errors.New("updater: component/os/arch not in manifest")
	ErrSHA256Mismatch    = errors.New("updater: downloaded SHA-256 does not match manifest")
	ErrReleaseNotNewer   = errors.New("updater: signed release is not newer")
	ErrCurrentVersionDev = errors.New("updater: current version is dev — refusing to update a non-release build")
	ErrInvalidConfig     = errors.New("updater: invalid configuration")
)

// New constructs an Updater after validating Config. It does NOT
// fetch anything; first network access happens on CheckAndStage.
func New(cfg Config) (*Updater, error) {
	if cfg.BaseURL == "" {
		return nil, fmt.Errorf("%w: BaseURL is required", ErrInvalidConfig)
	}
	if cfg.Component == "" {
		return nil, fmt.Errorf("%w: Component is required", ErrInvalidConfig)
	}
	if cfg.GOOS == "" || cfg.GOARCH == "" {
		return nil, fmt.Errorf("%w: GOOS and GOARCH are required", ErrInvalidConfig)
	}
	if cfg.CurrentVersion == "" {
		return nil, fmt.Errorf("%w: CurrentVersion is required", ErrInvalidConfig)
	}
	if cfg.CurrentVersion != "dev" && !semver.IsValid(cfg.CurrentVersion) {
		return nil, fmt.Errorf("%w: CurrentVersion must be a v-prefixed semantic version", ErrInvalidConfig)
	}
	key, err := loadReleaseKey(cfg.TrustedKeyFile)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	if cfg.LatestPath == "" {
		cfg.LatestPath = DefaultLatestPath
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = http.DefaultClient
	}
	if cfg.MaxArtifactBytes <= 0 {
		cfg.MaxArtifactBytes = 256 << 20
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	return &Updater{cfg: cfg, releaseKey: key}, nil
}

// CheckAndStage runs one update cycle: fetch latest tag, compare
// against CurrentVersion, fetch manifest, download artifact, verify
// SHA-256, write to staging path. Returns Result with Checked=true
// on every successful network round-trip (whether or not anything
// was downloaded), and an error only on hard failures (network
// errors, manifest parse errors, sha mismatches).
//
// Idempotency: if the same tag is already staged at StagePath with a
// matching SHA-256, the call returns Staged=false (we don't
// re-download) and UpToDate is set per the local-vs-remote tag
// comparison. The check is by SHA-256, not by mtime, so a
// half-finished download from a previous run gets re-tried.
func (u *Updater) CheckAndStage(ctx context.Context) (Result, error) {
	u.stageMu.Lock()
	defer u.stageMu.Unlock()

	if u.cfg.CurrentVersion == "dev" {
		return Result{
			SkippedReason: "current build is 'dev' (no buildinfo injection)",
		}, ErrCurrentVersionDev
	}

	tag, err := u.fetchLatestTag(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("fetch latest.txt: %w", err)
	}

	u.mu.Lock()
	u.lastSeen = tag
	u.mu.Unlock()

	if !semver.IsValid(tag) {
		return Result{Checked: true}, fmt.Errorf("latest.txt does not contain a v-prefixed semantic version")
	}
	if order := semver.Compare(tag, u.cfg.CurrentVersion); order <= 0 {
		return Result{Checked: true, UpToDate: order == 0, NewVersion: tag, SkippedReason: "latest release is not newer"}, nil
	}

	mf, authorization, err := u.fetchManifest(ctx, tag)
	if err != nil {
		return Result{Checked: true, NewVersion: tag},
			fmt.Errorf("fetch manifest %s: %w", tag, err)
	}

	c, err := u.selectComponent(mf)
	if err != nil {
		return Result{Checked: true, NewVersion: tag}, err
	}

	stagePath, err := u.resolveStagePath()
	if err != nil {
		return Result{Checked: true, NewVersion: tag},
			fmt.Errorf("resolve stage path: %w", err)
	}

	// Idempotent skip: if a staged file already exists with the
	// expected hash, just return Staged=false. This covers the
	// case where the operator restarts the miner between the
	// stage step and the apply step — we don't want to
	// re-download a 15 MiB artifact every restart.
	if stagedHashEquals(stagePath, c) {
		if err := authorization.save(stagePath); err != nil {
			return Result{Checked: true, NewVersion: tag}, err
		}
		return Result{
			Checked:       true,
			NewVersion:    tag,
			Staged:        false,
			StagedPath:    stagePath,
			SHA256:        c.SHA256,
			SizeBytes:     c.SizeBytes,
			SkippedReason: "stage file already matches manifest sha256",
		}, nil
	}

	artifactURL := u.cfg.BaseURL + "/" + tag + "/" + url.PathEscape(c.File)
	gotSize, gotSHA, err := u.downloadVerified(ctx, artifactURL, c.SHA256, c.SizeBytes, stagePath)
	if err != nil {
		return Result{Checked: true, NewVersion: tag},
			fmt.Errorf("download %s: %w", c.File, err)
	}
	if err := authorization.save(stagePath); err != nil {
		return Result{Checked: true, NewVersion: tag}, err
	}

	return Result{
		Checked:    true,
		Staged:     true,
		NewVersion: tag,
		StagedPath: stagePath,
		SHA256:     gotSHA,
		SizeBytes:  gotSize,
	}, nil
}

// LastSeenTag returns the most recent tag the Updater observed from
// latest.txt, or "" if no successful fetch has happened. Used by the
// dashboard / metrics surface so the operator can see "we know about
// vX.Y.Z but haven't applied it yet".
func (u *Updater) LastSeenTag() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.lastSeen
}

// fetchLatestTag is a one-shot HTTP GET that reads latest.txt and
// returns its trimmed body. Tags are validated against a small
// allow-list character class (alphanum + "+.-_") so a hostile
// response can't poison the stage path with shell metacharacters.
func (u *Updater) fetchLatestTag(ctx context.Context) (string, error) {
	url := u.cfg.BaseURL + "/" + strings.TrimLeft(u.cfg.LatestPath, "/")
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := u.cfg.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d for %s", resp.StatusCode, url)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", err
	}
	tag := strings.TrimSpace(string(body))
	if tag == "" {
		return "", fmt.Errorf("empty body for %s", url)
	}
	if !looksLikeTag(tag) {
		return "", fmt.Errorf("body does not look like a release tag: %q", tag)
	}
	return tag, nil
}

func looksLikeTag(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '+' || r == '.' || r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}

func (u *Updater) fetchReleaseFile(ctx context.Context, path string, maxBytes int64) ([]byte, error) {
	url := u.cfg.BaseURL + "/" + path
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d for %s", resp.StatusCode, url)
	}
	return readBounded(resp.Body, maxBytes)
}

func findComponent(m *Manifest, name, goos, goarch string) (ManifestComponent, bool) {
	for _, c := range m.Components {
		if c.Component == name && c.OS == goos && c.Arch == goarch {
			return c, true
		}
	}
	return ManifestComponent{}, false
}

// resolveStagePath returns the configured StagePath, falling back to
// <currentExePath>.next. The fallback is computed lazily because the
// process exec path is only available at runtime (and tests like to
// override it via Config.StagePath for hermetic temp-dir runs).
func (u *Updater) resolveStagePath() (string, error) {
	if u.cfg.StagePath != "" {
		return u.cfg.StagePath, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return exe + ".next", nil
}

// downloadVerified streams the artifact at `url` to `stagePath`,
// computing SHA-256 in flight, and renames into place atomically on
// match. Refuses to write more than MaxArtifactBytes. On any error
// (HTTP non-200, hash mismatch, size mismatch, write error) the
// partial file is removed so a subsequent retry starts clean.
func (u *Updater) downloadVerified(ctx context.Context, url, expectedSHA string, expectedSize int64, stagePath string) (int64, string, error) {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, "", err
	}
	resp, err := u.cfg.HTTPClient.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, "", fmt.Errorf("HTTP %d for %s", resp.StatusCode, url)
	}

	if err := os.MkdirAll(filepath.Dir(stagePath), 0o755); err != nil {
		return 0, "", fmt.Errorf("mkdir staging: %w", err)
	}
	f, err := os.CreateTemp(filepath.Dir(stagePath), ".qsdm-update-part-*")
	if err != nil {
		return 0, "", fmt.Errorf("create staging file: %w", err)
	}
	tmpPath := f.Name()
	defer os.Remove(tmpPath)

	hasher := sha256.New()
	cap := io.LimitReader(resp.Body, expectedSize+1)
	mw := io.MultiWriter(f, hasher)
	n, err := io.Copy(mw, cap)
	if cerr := f.Close(); err == nil && cerr != nil {
		err = cerr
	}
	if err != nil {
		return 0, "", fmt.Errorf("write staged artifact: %w", err)
	}
	if n != expectedSize {
		return 0, "", fmt.Errorf("size mismatch: got %d, manifest says %d", n, expectedSize)
	}

	got := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(got, expectedSHA) {
		return n, got, fmt.Errorf("%w: got %s, want %s", ErrSHA256Mismatch, got, expectedSHA)
	}

	// Atomic move into place. os.Rename is the right primitive
	// on every supported OS: POSIX is atomic by spec, and
	// Windows MoveFileEx-with-replace is atomic when the
	// source + destination are on the same volume (and they
	// always are here — both live next to the exe).
	if err := os.Rename(tmpPath, stagePath); err != nil {
		return n, got, fmt.Errorf("rename staged artifact: %w", err)
	}
	return n, got, nil
}
