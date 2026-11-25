//go:build !windows

package main

import (
	"os"
	"syscall"
)

// hardLinkCount returns how many names the file has (1 when unknown).
func hardLinkCount(info os.FileInfo) uint64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Nlink)
	}
	return 1
}

// renameRetryable: a rename on Linux or macOS does not fail on a lock.
func renameRetryable(error) bool {
	return false
}
