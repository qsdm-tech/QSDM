//go:build windows

package main

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// hardLinkCount is not checked on Windows: os.FileInfo carries no link count
// there, and reading it would mean opening the file (which can download a
// OneDrive placeholder). Hard links to user files are rare on Windows.
func hardLinkCount(os.FileInfo) uint64 {
	return 1
}

// renameRetryable reports the short-lived locks that virus scanners and the
// search indexer take; access denied is not retried.
func renameRetryable(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}
