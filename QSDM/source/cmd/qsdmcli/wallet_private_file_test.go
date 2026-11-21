package main

// Regression tests for the November 2026 security report on --force: qsdmcli
// truncated an existing output file in place, so a 0644 file stayed 0644 with
// the 24 recovery words in it while the CLI printed "(mode 0600)". Unix modes
// do not exist on Windows; there these tests check contents and refusals only.

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/blackbeardONE/QSDM/pkg/keystore"
)

// writeReadableFile creates path as a group- and world-readable file, the
// precondition of the report.
func writeReadableFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil { // the umask may have cleared bits
		t.Fatal(err)
	}
}

// assertPrivateFile checks that path is a regular file readable only by its
// owner (mode 0600) and, when want is set, that it holds want.
func assertPrivateFile(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if want != "" && string(got) != want {
		t.Fatalf("%s holds %q, want %q", path, got, want)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("%s is a symbolic link", path)
	}
	if runtime.GOOS == "windows" {
		return
	}
	if !info.Mode().IsRegular() {
		t.Fatalf("%s is not a regular file: %v", path, info.Mode())
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("%s has mode %04o, want 0600", path, perm)
	}
}

func assertNoTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create a symbolic link here: %v", err)
	}
}

func TestWriteFileExclusiveForceReplacesReadableFileWithPrivateFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "recovery.txt")
	writeReadableFile(t, path, "old contents\n")

	if err := writeFileExclusive(path, []byte("secret words\n"), true); err != nil {
		t.Fatalf("forced write: %v", err)
	}
	assertPrivateFile(t, path, "secret words\n")
	assertNoTempFiles(t, dir)

	want := "mode 0600"
	if runtime.GOOS == "windows" {
		want = "Windows: the folder's permissions apply"
	}
	if note := fileAccessNote(path); note != want {
		t.Fatalf("fileAccessNote = %q, want %q", note, want)
	}
}

func TestWriteFileExclusiveNewFileIsPrivate(t *testing.T) {
	for _, force := range []bool{false, true} {
		dir := t.TempDir()
		path := filepath.Join(dir, "new.txt")
		if err := writeFileExclusive(path, []byte("secret\n"), force); err != nil {
			t.Fatalf("force=%v: %v", force, err)
		}
		assertPrivateFile(t, path, "secret\n")
		assertNoTempFiles(t, dir)
	}
}

func TestWriteFileExclusiveRefusesExistingFileWithoutForce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "existing.txt")
	writeReadableFile(t, path, "keep me\n")

	err := writeFileExclusive(path, []byte("secret\n"), false)
	if !errors.Is(err, os.ErrExist) {
		t.Fatalf("expected the existing file to be refused, got %v", err)
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil || string(got) != "keep me\n" {
		t.Fatalf("existing file changed: %q, %v", got, readErr)
	}
}

func TestWriteFileExclusiveRefusesSymlinkTarget(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(dir, "victim.txt")
	writeReadableFile(t, victim, "victim\n")
	link := filepath.Join(dir, "recovery.txt")
	symlinkOrSkip(t, victim, link)

	for _, force := range []bool{false, true} {
		if err := writeFileExclusive(link, []byte("secret\n"), force); err == nil {
			t.Fatalf("force=%v: a write through a symbolic link was allowed", force)
		}
	}
	got, err := os.ReadFile(victim)
	if err != nil || string(got) != "victim\n" {
		t.Fatalf("link target changed: %q, %v", got, err)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the symbolic link was replaced: %v, %v", info, err)
	}
	assertNoTempFiles(t, dir)
}

func TestWriteFileExclusiveRefusesDirectoryAndHardLinkedTargets(t *testing.T) {
	dir := t.TempDir()
	folder := filepath.Join(dir, "folder")
	if err := os.Mkdir(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeFileExclusive(folder, []byte("secret\n"), true); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("expected a directory to be refused, got %v", err)
	}

	if runtime.GOOS == "windows" {
		return // link counts are not checked on Windows
	}
	first := filepath.Join(dir, "first.txt")
	writeReadableFile(t, first, "old\n")
	second := filepath.Join(dir, "second.txt")
	if err := os.Link(first, second); err != nil {
		t.Skipf("cannot create a hard link here: %v", err)
	}
	if err := writeFileExclusive(second, []byte("secret\n"), true); err == nil || !strings.Contains(err.Error(), "hard links") {
		t.Fatalf("expected a hard-linked file to be refused, got %v", err)
	}
	got, err := os.ReadFile(first)
	if err != nil || string(got) != "old\n" {
		t.Fatalf("hard-linked file changed: %q, %v", got, err)
	}
	assertNoTempFiles(t, dir)
}

func TestFileAccessNoteReportsTheRealMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no Unix modes")
	}
	path := filepath.Join(t.TempDir(), "readable.txt")
	writeReadableFile(t, path, "x\n")
	if note := fileAccessNote(path); !strings.HasPrefix(note, "mode 0644; WARNING") {
		t.Fatalf("fileAccessNote = %q, want the real mode 0644 and a warning", note)
	}
}

// newPassphraseFile writes a synthetic passphrase for the command tests.
func newPassphraseFile(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "passphrase.txt")
	if err := os.WriteFile(path, []byte("synthetic strong passphrase"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func assertRecoveryWordsFile(t *testing.T, path string) string {
	t.Helper()
	assertPrivateFile(t, path, "")
	words, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(strings.Fields(string(words))); got != keystore.RecoveryWords {
		t.Fatalf("%s holds %d words, want %d", path, got, keystore.RecoveryWords)
	}
	return string(words)
}

func TestWalletNewForceReplacesReadableFilesWithPrivateFiles(t *testing.T) {
	dir := t.TempDir()
	walletPath := filepath.Join(dir, "wallet.json")
	recoveryPath := filepath.Join(dir, "recovery.txt")
	passphrase := newPassphraseFile(t, dir)
	writeReadableFile(t, walletPath, "{}\n")
	writeReadableFile(t, recoveryPath, "placeholder\n")

	cli := &CLI{}
	if err := cli.walletNew([]string{
		"--out", walletPath,
		"--passphrase-file", passphrase,
		"--recovery-out", recoveryPath,
		"--force",
	}); err != nil {
		t.Fatalf("wallet new --force: %v", err)
	}
	assertPrivateFile(t, walletPath, "")
	if _, err := loadKeystore(walletPath); err != nil {
		t.Fatalf("new keystore: %v", err)
	}
	assertRecoveryWordsFile(t, recoveryPath)
	assertNoTempFiles(t, dir)
}

func TestWalletNewForceChecksRecoveryPathBeforeReplacingKeystore(t *testing.T) {
	dir := t.TempDir()
	walletPath := filepath.Join(dir, "wallet.json")
	victim := filepath.Join(dir, "victim.txt")
	link := filepath.Join(dir, "recovery.txt")
	passphrase := newPassphraseFile(t, dir)
	writeReadableFile(t, walletPath, "old keystore\n")
	writeReadableFile(t, victim, "victim\n")
	symlinkOrSkip(t, victim, link)

	cli := &CLI{}
	err := cli.walletNew([]string{
		"--out", walletPath,
		"--passphrase-file", passphrase,
		"--recovery-out", link,
		"--force",
	})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("expected the symbolic link to be refused, got %v", err)
	}
	if got, _ := os.ReadFile(walletPath); string(got) != "old keystore\n" {
		t.Fatalf("keystore was replaced before the recovery path was checked: %q", got)
	}
	if got, _ := os.ReadFile(victim); string(got) != "victim\n" {
		t.Fatalf("link target changed: %q", got)
	}
}

func TestWalletExportRecoveryForceReplacesReadableFileWithPrivateFile(t *testing.T) {
	dir := t.TempDir()
	walletPath := filepath.Join(dir, "wallet.json")
	firstWords := filepath.Join(dir, "first-recovery.txt")
	passphrase := newPassphraseFile(t, dir)
	cli := &CLI{}
	if err := cli.walletNew([]string{
		"--out", walletPath,
		"--passphrase-file", passphrase,
		"--recovery-out", firstWords,
	}); err != nil {
		t.Fatalf("wallet new: %v", err)
	}
	original := assertRecoveryWordsFile(t, firstWords)

	exported := filepath.Join(dir, "exported.txt")
	writeReadableFile(t, exported, "placeholder\n")
	if err := cli.walletExportRecovery([]string{
		"--in", walletPath,
		"--out", exported,
		"--passphrase-file", passphrase,
		"--force",
	}); err != nil {
		t.Fatalf("export-recovery --force: %v", err)
	}
	if got := assertRecoveryWordsFile(t, exported); got != original {
		t.Fatal("exported recovery words differ from the original")
	}

	// Without --force an existing file is still refused and kept as it was.
	kept := filepath.Join(dir, "kept.txt")
	writeReadableFile(t, kept, "keep me\n")
	if err := cli.walletExportRecovery([]string{
		"--in", walletPath,
		"--out", kept,
		"--passphrase-file", passphrase,
	}); err == nil {
		t.Fatal("export-recovery overwrote an existing file without --force")
	}
	if got, _ := os.ReadFile(kept); string(got) != "keep me\n" {
		t.Fatalf("existing file changed without --force: %q", got)
	}
	assertNoTempFiles(t, dir)
}

func TestWalletEnableRecoveryForceWritesPrivateFiles(t *testing.T) {
	dir := t.TempDir()
	walletPath := filepath.Join(dir, "wallet.json")
	recoveryPath := filepath.Join(dir, "recovery.txt")
	passphrase := newPassphraseFile(t, dir)
	server := newLegacyRecoveryServer(t)
	cli := &CLI{baseURL: server.URL + "/api/v1", client: server.Client()}
	if err := cli.walletNew([]string{
		"--out", walletPath,
		"--passphrase-file", passphrase,
	}); err != nil {
		t.Fatalf("create legacy wallet: %v", err)
	}
	// A readable keystore and a readable words file must both come out private.
	if err := os.Chmod(walletPath, 0o644); err != nil {
		t.Fatal(err)
	}
	writeReadableFile(t, recoveryPath, "placeholder\n")

	if err := cli.walletEnableLegacyRecovery([]string{
		"--in", walletPath,
		"--passphrase-file", passphrase,
		"--recovery-out", recoveryPath,
		"--confirm-timeout", "2s",
		"--force",
	}); err != nil {
		t.Fatalf("enable-recovery --force: %v", err)
	}
	assertRecoveryWordsFile(t, recoveryPath)
	assertPrivateFile(t, walletPath, "")
	migrated, err := loadKeystore(walletPath)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.Recovery == nil || migrated.Recovery.Scheme != keystore.LegacyRecoveryScheme {
		t.Fatalf("legacy recovery metadata missing: %+v", migrated.Recovery)
	}
	backups, err := filepath.Glob(walletPath + ".pre-recovery-*.bak")
	if err != nil || len(backups) != 1 {
		t.Fatalf("migration backup count=%d err=%v", len(backups), err)
	}
	assertPrivateFile(t, backups[0], "")
	assertNoTempFiles(t, dir)
}

func TestWalletEnableRecoveryRefusesSymlinkedKeystoreBeforeContactingCore(t *testing.T) {
	dir := t.TempDir()
	walletPath := filepath.Join(dir, "wallet.json")
	linkPath := filepath.Join(dir, "wallet-link.json")
	recoveryPath := filepath.Join(dir, "recovery.txt")
	passphrase := newPassphraseFile(t, dir)
	// An unreachable API: the command must stop before any request.
	cli := &CLI{baseURL: "http://127.0.0.1:1/api/v1"}
	if err := cli.walletNew([]string{
		"--out", walletPath,
		"--passphrase-file", passphrase,
	}); err != nil {
		t.Fatalf("create legacy wallet: %v", err)
	}
	symlinkOrSkip(t, walletPath, linkPath)

	err := cli.walletEnableLegacyRecovery([]string{
		"--in", linkPath,
		"--passphrase-file", passphrase,
		"--recovery-out", recoveryPath,
	})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("expected the symbolic-link keystore to be refused, got %v", err)
	}
	if _, statErr := os.Stat(recoveryPath); !os.IsNotExist(statErr) {
		t.Fatalf("recovery words were written before the keystore check: %v", statErr)
	}
}
