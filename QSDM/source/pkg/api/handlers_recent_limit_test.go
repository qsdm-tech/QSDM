package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/blackbeardONE/QSDM/pkg/chain"
	"github.com/blackbeardONE/QSDM/pkg/contracts"
)

// The recent-record lists read ?n= from the client. A call returns at most
// RecentListMaxLimit records, and a huge n gets a normal answer.

const recentLimitStored = RecentListMaxLimit + 200

func fillRecentTraces(t *testing.T, tr *contracts.CallTracer) {
	t.Helper()
	for i := 0; i < recentLimitStored; i++ {
		tb := tr.BeginTrace(fmt.Sprintf("limit-%d", i), "c", "fn", "alice", nil)
		tr.Finish(tb, 0, nil, nil)
	}
}

// recentLimitCases maps a query to the expected count; -1 means "any count up
// to RecentListMaxLimit" (10000000000 does not fit a 32-bit int, so Atoi
// fails there and the default applies).
var recentLimitCases = map[string]int{
	"n=7":           7,
	"n=5000":        RecentListMaxLimit,
	"n=10000000000": -1,
}

func checkRecentCount(t *testing.T, query string, code int, count int, want int) {
	t.Helper()
	if code != http.StatusOK {
		t.Fatalf("%s: status %d, want 200", query, code)
	}
	if count > RecentListMaxLimit {
		t.Fatalf("%s: %d records, more than RecentListMaxLimit=%d", query, count, RecentListMaxLimit)
	}
	if want >= 0 && count != want {
		t.Fatalf("%s: %d records, want %d", query, count, want)
	}
}

func TestListContractTraces_CapsN(t *testing.T) {
	h := makeTraceHandlers(t)
	fillRecentTraces(t, h.contractEngine.Tracer())

	for query, want := range recentLimitCases {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/contracts/traces?"+query, nil)
		w := httptest.NewRecorder()
		h.ListContractTraces(w, req)
		var body struct {
			Count  int               `json:"count"`
			Traces []json.RawMessage `json:"traces"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: decode: %v", query, err)
		}
		if body.Count != len(body.Traces) {
			t.Fatalf("%s: count %d but %d traces", query, body.Count, len(body.Traces))
		}
		checkRecentCount(t, query, w.Code, body.Count, want)
	}
}

func TestAdminAPI_TracesAndReceiptsCapN(t *testing.T) {
	api := newTestAdminAPI()
	api.Tracer = contracts.NewCallTracer(2 * recentLimitStored)
	fillRecentTraces(t, api.Tracer)
	for i := 0; i < recentLimitStored; i++ {
		api.Receipts.Store(&chain.TxReceipt{
			TxID:        fmt.Sprintf("limit-tx-%d", i),
			BlockHeight: uint64(i),
			BlockHash:   "abc",
			Status:      chain.ReceiptSuccess,
			Timestamp:   time.Now(),
		})
	}
	mux := http.NewServeMux()
	api.RegisterRoutes(mux)

	for _, path := range []string{"/api/admin/traces", "/api/admin/receipts"} {
		for query, want := range recentLimitCases {
			req := httptest.NewRequest(http.MethodGet, path+"?"+query, nil)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)
			var records []json.RawMessage
			if err := json.Unmarshal(w.Body.Bytes(), &records); err != nil {
				t.Fatalf("%s?%s: decode: %v", path, query, err)
			}
			checkRecentCount(t, path+"?"+query, w.Code, len(records), want)
		}
	}
}
