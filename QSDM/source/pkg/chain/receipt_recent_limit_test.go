package chain

import (
	"math"
	"testing"
)

// Recent sizes its result by what the store holds, never by n: n comes from
// an API query, and a huge n used to size the allocation directly.
func TestReceiptStore_RecentNeverAllocatesPastStoredReceipts(t *testing.T) {
	rs := NewReceiptStore()
	for i, id := range []string{"tx-a", "tx-b", "tx-c"} {
		rs.Store(makeReceipt(id, uint64(i), ReceiptSuccess))
	}

	for _, n := range []int{4, 3, 1000, math.MaxInt} {
		got := rs.Recent(n)
		if len(got) != 3 || cap(got) != 3 {
			t.Fatalf("Recent(%d): len %d cap %d, want 3 and 3", n, len(got), cap(got))
		}
		if got[0].TxID != "tx-c" || got[2].TxID != "tx-a" {
			t.Fatalf("Recent(%d): want newest first, got %s ... %s", n, got[0].TxID, got[2].TxID)
		}
	}
	if got := rs.Recent(1); len(got) != 1 || got[0].TxID != "tx-c" {
		t.Fatalf("Recent(1) = %d receipts, want tx-c", len(got))
	}
	for _, n := range []int{0, -1, math.MinInt} {
		if got := rs.Recent(n); got != nil {
			t.Fatalf("Recent(%d) = %d receipts, want none", n, len(got))
		}
	}
}
