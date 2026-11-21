package server

import (
	"net/http"
	"testing"
)

// Devices of the account (contracts/api-conta.md, "Aparelhos").

func TestDevicesListsOnlyTheActiveOnesAndMarksThisOne(t *testing.T) {
	h := newHarness(t)
	client := h.browser()
	register(h, client, "ana@exemplo.com", "senha-forte-1")
	other := h.browser()
	login(h, other, "ana@exemplo.com", "senha-forte-1")
	gone := h.browser()
	login(h, gone, "ana@exemplo.com", "senha-forte-1")
	h.do(gone, call{method: http.MethodPost, path: "/v1/auth/logout"})

	response, body := h.do(client, call{path: "/v1/devices"})
	devices, _ := body["devices"].([]any)
	if response.StatusCode != http.StatusOK || len(devices) != 2 {
		t.Fatalf("devices: %d %v", response.StatusCode, body)
	}
	current := 0
	for _, raw := range devices {
		device := raw.(map[string]any)
		if device["id"] == nil || device["name"] != "Chrome no Linux" || device["seenAt"] == nil {
			t.Errorf("device: %v", device)
		}
		if device["current"] == true {
			current++
		}
	}
	if current != 1 {
		t.Fatalf("%d devices marked current", current)
	}
}

func TestRenamingAndSigningOutADevice(t *testing.T) {
	h := newHarness(t)
	client := h.browser()
	register(h, client, "ana@exemplo.com", "senha-forte-1")
	other := h.browser()
	login(h, other, "ana@exemplo.com", "senha-forte-1")
	_, body := h.do(client, call{path: "/v1/devices"})
	var otherID string
	for _, raw := range body["devices"].([]any) {
		if device := raw.(map[string]any); device["current"] != true {
			otherID = device["id"].(string)
		}
	}
	if response, body := h.do(client, call{method: http.MethodPatch, path: "/v1/devices/" + otherID, body: map[string]any{"name": "  Celular da Ana  "}}); response.StatusCode != http.StatusOK {
		t.Fatalf("rename: %d %v", response.StatusCode, body)
	}
	var name string
	_ = h.db.QueryRow(`SELECT name FROM devices WHERE id = ?`, otherID).Scan(&name)
	if name != "Celular da Ana" {
		t.Fatalf("name = %q", name)
	}
	if response, body := h.do(client, call{method: http.MethodPatch, path: "/v1/devices/" + otherID, body: map[string]any{"name": "   "}}); response.StatusCode != http.StatusBadRequest || body["error"] != "invalid_name" {
		t.Fatalf("empty name: %d %v", response.StatusCode, body)
	}
	if response, _ := h.do(client, call{method: http.MethodDelete, path: "/v1/devices/" + otherID}); response.StatusCode != http.StatusOK {
		t.Fatalf("sign out: %d", response.StatusCode)
	}
	if response, _ := h.do(other, call{path: "/v1/me"}); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("the signed-out device still reaches me: %d", response.StatusCode)
	}
}

func TestADeviceOfAnotherAccountIsNotFound(t *testing.T) {
	h := newHarness(t)
	ana := h.browser()
	register(h, ana, "ana@exemplo.com", "senha-forte-1")
	bia := h.browser()
	register(h, bia, "bia@exemplo.com", "senha-forte-1")
	_, body := h.do(bia, call{path: "/v1/devices"})
	biaDevice := body["devices"].([]any)[0].(map[string]any)["id"].(string)
	for _, c := range []call{
		{method: http.MethodPatch, path: "/v1/devices/" + biaDevice, body: map[string]any{"name": "meu"}},
		{method: http.MethodDelete, path: "/v1/devices/" + biaDevice},
	} {
		if response, body := h.do(ana, c); response.StatusCode != http.StatusNotFound || body["error"] != "not_found" {
			t.Errorf("%s: %d %v", c.method, response.StatusCode, body)
		}
	}
	if response, _ := h.do(bia, call{path: "/v1/me"}); response.StatusCode != http.StatusOK {
		t.Fatal("another account signed Bia out")
	}
}
