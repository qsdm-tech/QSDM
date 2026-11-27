package contracts

import (
	"fmt"
	"math"
	"testing"
)

// Recent sizes its result by what the tracer holds, never by n: n comes from
// an API query, and a huge n used to size the allocation directly.
func TestCallTracer_RecentNeverAllocatesPastStoredTraces(t *testing.T) {
	ct := NewCallTracer(100)
	for i := 0; i < 3; i++ {
		tb := ct.BeginTrace(fmt.Sprintf("t-%d", i), "c", "f", "a", nil)
		ct.Finish(tb, 0, nil, nil)
	}

	for _, n := range []int{4, 3, 1000, math.MaxInt} {
		got := ct.Recent(n)
		if len(got) != 3 || cap(got) != 3 {
			t.Fatalf("Recent(%d): len %d cap %d, want 3 and 3", n, len(got), cap(got))
		}
		if got[0].TraceID != "t-2" || got[2].TraceID != "t-0" {
			t.Fatalf("Recent(%d): want newest first, got %s ... %s", n, got[0].TraceID, got[2].TraceID)
		}
	}
	if got := ct.Recent(2); len(got) != 2 || got[0].TraceID != "t-2" || got[1].TraceID != "t-1" {
		t.Fatalf("Recent(2) = %d traces, want t-2, t-1", len(got))
	}
	for _, n := range []int{0, -1, math.MinInt} {
		if got := ct.Recent(n); got != nil {
			t.Fatalf("Recent(%d) = %d traces, want none", n, len(got))
		}
	}
}
