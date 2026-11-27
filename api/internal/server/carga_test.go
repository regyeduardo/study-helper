package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Many accounts at once (spec 007, FR-009, T038): 20 accounts doing what the app asks of the server (open the app, the map, a note,
// create, rename, move to the trash, the space) for some seconds while 2 fake generation jobs keep two processors busy, as the
// Chromium of the jobs in the account does. The p95 of each route stays inside the server's share of the targets of SC-001: of the
// 1 s of "create, rename, move or delete ends and is saved" and of the 1 s of "open a note", the server keeps at most 250 ms, which
// leaves the rest to the network of a phone and to the device. Skipped with -short.

const (
	loadAccounts   = 20
	loadNotes      = 100
	loadFor        = 6 * time.Second
	loadBusyJobs   = 2
	loadServerP95  = 250 * time.Millisecond
	loadMinPerPath = 20
)

type loadClient struct {
	h      *harness
	client *http.Client
}

// send is h.do without t.Fatal, for the goroutines of the load.
func (c loadClient) send(method, path string, body any) (int, map[string]any, time.Duration, error) {
	var reader io.Reader = http.NoBody
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	request, _ := http.NewRequest(method, c.h.api.URL+path, reader)
	if method != http.MethodGet {
		request.Header.Set("X-Estudo", "1")
		request.Header.Set("Origin", appOrigin)
		request.Header.Set("Content-Type", "application/json")
	}
	started := time.Now()
	response, err := c.client.Do(request)
	if err != nil {
		return 0, nil, 0, err
	}
	defer response.Body.Close()
	var out map[string]any
	raw, _ := io.ReadAll(response.Body)
	took := time.Since(started)
	_ = json.Unmarshal(raw, &out)
	return response.StatusCode, out, took, nil
}

type loadTimes struct {
	mu    sync.Mutex
	times map[string][]time.Duration
	fails []string
}

func (l *loadTimes) add(route string, status int, took time.Duration, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err != nil || status != http.StatusOK {
		l.fails = append(l.fails, fmt.Sprintf("%s: %d %v", route, status, err))
		return
	}
	l.times[route] = append(l.times[route], took)
}

func p95(times []time.Duration) time.Duration {
	sorted := slices.Clone(times)
	slices.Sort(sorted)
	return sorted[(len(sorted)*95+99)/100-1]
}

// busy keeps one processor working until stop closes, like a job's Chromium.
func busy(stop <-chan struct{}, done *sync.WaitGroup) {
	defer done.Done()
	runtime.LockOSThread()
	sum := sha256.Sum256([]byte("trabalho"))
	for {
		select {
		case <-stop:
			return
		default:
			for range 1000 {
				sum = sha256.Sum256(sum[:])
			}
		}
	}
}

func TestLoadManyAccounts(t *testing.T) {
	if testing.Short() {
		t.Skip("teste de carga: rode sem -short")
	}
	h := newHarness(t)
	accounts := make([]loadClient, loadAccounts)
	revs := make([]map[string]int64, loadAccounts)
	var setup sync.WaitGroup
	var setupFailed atomic.Value
	for i := range accounts {
		client, _ := h.account("enabled", true, fmt.Sprintf("conta%02d@exemplo.com", i))
		accounts[i] = loadClient{h: h, client: client}
		revs[i] = map[string]int64{}
		setup.Add(1)
		go func() {
			defer setup.Done()
			for n := range loadNotes {
				id := fmt.Sprintf("n%03d", n)
				status, body, _, err := accounts[i].send(http.MethodPut, "/v1/library/items/"+id, map[string]any{"baseRev": 0, "row": row(fmt.Sprintf("Nota de estudo %03d", n), nil)})
				if err != nil || status != http.StatusOK {
					setupFailed.Store(fmt.Sprintf("seed %d/%s: %d %v %v", i, id, status, err, body))
					return
				}
				revs[i][id] = num(body["rev"])
			}
		}()
	}
	setup.Wait()
	if failed := setupFailed.Load(); failed != nil {
		t.Fatal(failed)
	}

	stop := make(chan struct{})
	var jobs sync.WaitGroup
	for range loadBusyJobs {
		jobs.Add(1)
		go busy(stop, &jobs)
	}
	times := &loadTimes{times: map[string][]time.Duration{}}
	deadline := time.Now().Add(loadFor)
	var users sync.WaitGroup
	for i, account := range accounts {
		users.Add(1)
		go func() {
			defer users.Done()
			random := rand.New(rand.NewPCG(uint64(i), 7))
			made := 0
			for time.Now().Before(deadline) {
				note := fmt.Sprintf("n%03d", random.IntN(loadNotes))
				switch step := random.IntN(7); step {
				case 0:
					status, _, took, err := account.send(http.MethodGet, "/v1/me", nil)
					times.add("GET /v1/me", status, took, err)
				case 1:
					status, _, took, err := account.send(http.MethodGet, "/v1/library/map", nil)
					times.add("GET /v1/library/map", status, took, err)
				case 2:
					status, _, took, err := account.send(http.MethodGet, "/v1/library/items/"+note, nil)
					times.add("GET /v1/library/items/{id}", status, took, err)
				case 3, 4:
					// rename, or move to the trash and back: one PUT of the row at its rev; a name of its own, as the app sends (a name taken
					// in the folder is refused since spec 005, FR-021)
					fields := row(fmt.Sprintf("Nota renomeada %s %d", note, random.IntN(1000)), nil)
					if step == 4 && random.IntN(2) == 0 {
						fields["trashedAt"] = "2026-11-24T10:00:00Z"
					}
					status, body, took, err := account.send(http.MethodPut, "/v1/library/items/"+note, map[string]any{"baseRev": revs[i][note], "row": fields})
					times.add("PUT /v1/library/items/{id}", status, took, err)
					if status == http.StatusOK {
						revs[i][note] = num(body["rev"])
					}
				case 5:
					made++
					status, _, took, err := account.send(http.MethodPut, fmt.Sprintf("/v1/library/items/novo%03d", made), map[string]any{"baseRev": 0, "row": row(fmt.Sprintf("Nota nova %03d", made), nil)})
					times.add("PUT /v1/library/items/{id} (criar)", status, took, err)
				case 6:
					status, _, took, err := account.send(http.MethodGet, "/v1/space", nil)
					times.add("GET /v1/space", status, took, err)
				}
			}
		}()
	}
	users.Wait()
	close(stop)
	jobs.Wait()

	if len(times.fails) > 0 {
		t.Fatalf("%d pedidos falharam, o primeiro: %s", len(times.fails), times.fails[0])
	}
	routes := []string{"GET /v1/me", "GET /v1/library/map", "GET /v1/library/items/{id}", "PUT /v1/library/items/{id}", "PUT /v1/library/items/{id} (criar)", "GET /v1/space"}
	for _, route := range routes {
		measured := times.times[route]
		if len(measured) < loadMinPerPath {
			t.Fatalf("%s: só %d pedidos em %s", route, len(measured), loadFor)
		}
		got := p95(measured)
		t.Logf("%-36s %5d pedidos, p95 %s", route, len(measured), got.Round(time.Millisecond))
		if got > loadServerP95 {
			t.Errorf("%s: p95 %s passou de %s com %d contas e %d trabalhos", route, got.Round(time.Millisecond), loadServerP95, loadAccounts, loadBusyJobs)
		}
	}
}
