package dashboard

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/blackbeardONE/QSDM/pkg/api"
	"github.com/blackbeardONE/QSDM/pkg/monitoring"
)

func TestParseLocalRedirect(t *testing.T) {
	for s, want := range map[string]bool{
		"/":                    true,
		"/ok?a=1":              true,
		"/settings#keys":       true,
		"/%2F%2Fevil.example":  true, // a path on this dashboard
		"":                     false,
		"https://evil.example": false,
		"http:/evil.example":   false,
		"//evil.example":       false,
		"/\\evil.example":      false,
		"/\t/evil.example":     false,
		"/\n/evil.example":     false,
		"\\\\evil.example":     false,
		"javascript:alert(1)":  false,
		"evil.example/path":    false,
	} {
		if got := parseLocalRedirect(s) != nil; got != want {
			t.Errorf("parseLocalRedirect(%q) accepted = %v, want %v", s, got, want)
		}
	}
}

// After a successful form login the dashboard follows ?redirect= only to its
// own paths; anything else lands on "/".
func TestDashboardLoginRedirectStaysOnDashboard(t *testing.T) {
	auth, err := api.NewAuthManager()
	if err != nil {
		t.Fatal(err)
	}
	auth.SetJWTHMACFallbackSecret("login-redirect-test-secret")
	const address = "0123456789abcdef0123456789abcdef0123456789"
	token, err := auth.CreateToken("user-1", address, "user", api.TokenTypeAccess, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/auth/login" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"` + token + `","expires_in":900}`))
	}))
	t.Cleanup(backend.Close)

	m := monitoring.GetMetrics()
	d := NewDashboard(m, monitoring.NewHealthChecker(m), "0", false, DashboardNvidiaLock{}, "login-redirect-test-secret", "", false, backend.URL, auth)

	for redirect, want := range map[string]string{
		"":                      "/",
		"/settings?tab=keys":    "/settings?tab=keys",
		"/settings%20page?tab=keys#public": "/settings%20page?tab=keys#public",
		"https://evil.example/": "/",
		"//evil.example/":       "/",
		"/\\evil.example/":      "/",
		"\t//evil.example/":     "/",
	} {
		target := "/api/auth/login"
		if redirect != "" {
			target += "?redirect=" + url.QueryEscape(redirect)
		}
		form := url.Values{"address": {address}, "password": {"irrelevant"}}
		req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		d.handleLogin(w, req)

		if w.Code != http.StatusFound {
			t.Fatalf("redirect=%q: status %d, want 302 (body %q)", redirect, w.Code, w.Body.String())
		}
		if got := w.Header().Get("Location"); got != want {
			t.Fatalf("redirect=%q: Location %q, want %q", redirect, got, want)
		}
	}
}
