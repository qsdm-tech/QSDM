package updater

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/cloudflare/circl/sign/mldsa/mldsa87"
	"golang.org/x/mod/semver"
)

const (
	maxManifestBytes      = 1 << 20
	maxSignatureFileBytes = 2*mldsa87.SignatureSize + 64
	maxAuthorizationBytes = 2 * (maxManifestBytes + maxSignatureFileBytes)
)

type manifestAuthorization struct {
	Manifest  []byte `json:"manifest"`
	Signature []byte `json:"signature"`
}

func loadReleaseKey(path string) (*mldsa87.PublicKey, error) {
	if path == "" {
		return nil, errors.New("a trusted release public key file is required")
	}
	body, err := readFileBounded(path, 2*mldsa87.PublicKeySize+64)
	if err != nil {
		return nil, fmt.Errorf("read trusted release public key: %w", err)
	}
	keyBytes, err := hex.DecodeString(strings.TrimSpace(string(bytes.TrimPrefix(body, utf8BOM))))
	if err != nil || len(keyBytes) != mldsa87.PublicKeySize {
		return nil, errors.New("trusted release key must be a hex-encoded ML-DSA-87 public key")
	}
	var key mldsa87.PublicKey
	if err := key.UnmarshalBinary(keyBytes); err != nil {
		return nil, fmt.Errorf("decode trusted release public key: %w", err)
	}
	return &key, nil
}

func (u *Updater) verifyManifest(a manifestAuthorization) (*Manifest, error) {
	if len(a.Manifest) > maxManifestBytes || len(a.Signature) != mldsa87.SignatureSize ||
		!mldsa87.Verify(u.releaseKey, a.Manifest, nil, a.Signature) {
		return nil, errors.New("invalid release manifest signature")
	}
	var m Manifest
	if err := json.Unmarshal(bytes.TrimPrefix(a.Manifest, utf8BOM), &m); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	if u.cfg.CurrentVersion == "dev" || !semver.IsValid(m.Version) || semver.Compare(m.Version, u.cfg.CurrentVersion) <= 0 {
		return nil, fmt.Errorf("%w: staged %q, running %q", ErrReleaseNotNewer, m.Version, u.cfg.CurrentVersion)
	}
	return &m, nil
}

func (u *Updater) fetchManifest(ctx context.Context, tag string) (*Manifest, manifestAuthorization, error) {
	path := tag + "/" + ManifestFileName
	body, err := u.fetchReleaseFile(ctx, path, maxManifestBytes)
	if err != nil {
		return nil, manifestAuthorization{}, err
	}
	signatureText, err := u.fetchReleaseFile(ctx, path+".sig", maxSignatureFileBytes)
	if err != nil {
		return nil, manifestAuthorization{}, fmt.Errorf("fetch signed manifest companion: %w", err)
	}
	sig, err := hex.DecodeString(strings.TrimSpace(string(bytes.TrimPrefix(signatureText, utf8BOM))))
	if err != nil {
		return nil, manifestAuthorization{}, errors.New("release signature is not valid hexadecimal")
	}

	authorization := manifestAuthorization{Manifest: body, Signature: sig}
	m, err := u.verifyManifest(authorization)
	if err != nil {
		return nil, manifestAuthorization{}, err
	}
	if m.Version != tag {
		return nil, manifestAuthorization{}, fmt.Errorf("signed manifest version %q does not match tag %q", m.Version, tag)
	}
	return m, authorization, nil
}

func (u *Updater) selectComponent(m *Manifest) (ManifestComponent, error) {
	component, ok := findComponent(m, u.cfg.Component, u.cfg.GOOS, u.cfg.GOARCH)
	if !ok {
		return ManifestComponent{}, fmt.Errorf("%w: %s/%s/%s in tag %s", ErrComponentNotFound,
			u.cfg.Component, u.cfg.GOOS, u.cfg.GOARCH, m.Version)
	}
	if component.File == "" || component.File == "." || component.File == ".." || strings.ContainsAny(component.File, "/\\") {
		return ManifestComponent{}, errors.New("signed component file must be a single filename")
	}
	digest, err := hex.DecodeString(component.SHA256)
	if err != nil || len(digest) != sha256.Size || component.SizeBytes <= 0 || component.SizeBytes > u.cfg.MaxArtifactBytes {
		return ManifestComponent{}, errors.New("signed component has an invalid digest or size")
	}
	return component, nil
}

func (a manifestAuthorization) save(stagePath string) error {
	f, err := os.CreateTemp(filepath.Dir(stagePath), ".qsdm-update-auth-*")
	if err != nil {
		return fmt.Errorf("stage update authorization: %w", err)
	}
	defer os.Remove(f.Name())
	writeErr := json.NewEncoder(f).Encode(a)
	if err := errors.Join(writeErr, f.Close()); err != nil {
		return fmt.Errorf("stage update authorization: %w", err)
	}
	if err := os.Rename(f.Name(), stagePath+".auth"); err != nil {
		return fmt.Errorf("save update authorization: %w", err)
	}
	return nil
}

func readFileBounded(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return readBounded(f, limit)
}

func readBounded(r io.Reader, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, errors.New("release metadata exceeds its size limit")
	}
	return body, nil
}
