package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func stagedHashEquals(path string, component ManifestComponent) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	return copyAndVerifyArtifact(io.Discard, f, component) == nil
}

func copyAndVerifyArtifact(dst io.Writer, src *os.File, component ManifestComponent) error {
	info, err := src.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != component.SizeBytes {
		return errors.New("staged artifact type or size does not match the signed manifest")
	}

	digest := sha256.New()
	count, err := io.Copy(io.MultiWriter(dst, digest), io.LimitReader(src, component.SizeBytes+1))
	if err != nil {
		return err
	}
	if count != component.SizeBytes || !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), component.SHA256) {
		return ErrSHA256Mismatch
	}
	return nil
}

// prepareVerifiedArtifact hashes the copy that will be installed, so changes
// to the staging file after verification cannot change the installed binary.
func (u *Updater) prepareVerifiedArtifact(stagePath, currentExePath string) (string, error) {
	src, err := os.Open(stagePath)
	if errors.Is(err, os.ErrNotExist) {
		return "", ErrNoStagedUpdate
	}
	if err != nil {
		return "", fmt.Errorf("open staged artifact: %w", err)
	}
	defer src.Close()

	body, err := readFileBounded(stagePath+".auth", maxAuthorizationBytes)
	if err != nil {
		return "", fmt.Errorf("read staged update authorization: %w", err)
	}
	var authorization manifestAuthorization
	if err := json.Unmarshal(body, &authorization); err != nil {
		return "", fmt.Errorf("decode staged update authorization: %w", err)
	}
	manifest, err := u.verifyManifest(authorization)
	if err != nil {
		return "", err
	}
	component, err := u.selectComponent(manifest)
	if err != nil {
		return "", err
	}

	f, err := os.CreateTemp(filepath.Dir(currentExePath), ".qsdm-update-verified-*")
	if err != nil {
		return "", fmt.Errorf("create verified artifact: %w", err)
	}
	path := f.Name()
	keep := false
	defer func() {
		if !keep {
			_ = f.Close()
			_ = os.Remove(path)
		}
	}()
	if err := copyAndVerifyArtifact(f, src, component); err != nil {
		return "", fmt.Errorf("verify staged artifact: %w", err)
	}
	if err := f.Chmod(0o755); err != nil {
		return "", err
	}
	if err := errors.Join(f.Sync(), f.Close()); err != nil {
		return "", err
	}

	keep = true
	return path, nil
}

// ApplyStaged verifies a local copy of the staged release before promotion.
// A successful start of the replacement exits the old process.
func (u *Updater) ApplyStaged(stagePath, currentExePath string, argv []string) error {
	u.stageMu.Lock()
	defer u.stageMu.Unlock()

	verifiedPath, err := u.prepareVerifiedArtifact(stagePath, currentExePath)
	if err != nil {
		return err
	}
	defer os.Remove(verifiedPath)

	oldPath := currentExePath + ".old"
	if err := os.Rename(currentExePath, oldPath); err != nil {
		return fmt.Errorf("apply: back up current binary: %w", err)
	}
	if err := os.Rename(verifiedPath, currentExePath); err != nil {
		return applyRollback(oldPath, currentExePath, fmt.Errorf("apply: promote verified binary: %w", err))
	}

	var args []string
	if len(argv) > 1 {
		args = argv[1:]
	}
	cmd := exec.Command(currentExePath, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		return applyRollback(oldPath, currentExePath, fmt.Errorf("apply: start new binary: %w", err))
	}

	// Keep the staging pair available for a retry or a concurrent poll that
	// has already staged a newer release. The new binary skips older versions.
	os.Exit(0)
	return nil
}

func applyRollback(oldPath, currentExePath string, cause error) error {
	if err := os.Rename(oldPath, currentExePath); err != nil {
		return errors.Join(cause, fmt.Errorf("apply: restore prior binary from %s: %w", oldPath, err))
	}
	return cause
}

// ApplyStagedIfPresent looks for a newer .next file next to the running executable.
func (u *Updater) ApplyStagedIfPresent(currentExePath string, argv []string) (bool, error) {
	err := u.ApplyStaged(currentExePath+".next", currentExePath, argv)
	if errors.Is(err, ErrNoStagedUpdate) || errors.Is(err, ErrReleaseNotNewer) {
		return false, nil
	}
	return false, err
}
