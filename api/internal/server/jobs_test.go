package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// Generating in the account (spec 007, história 2, research R10b; contracts/api-jobs.md): the service keeps a queue of jobs and opens,
// for each one, the app itself in a headless Chromium, which runs the same call of the generations store the device would and reports
// its progress and its result. Here the "Chromium" is a fake that does what the worker page does, through the same routes.

// worker plays the app page of a job: it enters with the ticket and talks to the job's routes with the job's own session.
type worker struct {
	h      *harness
	client *http.Client
	id     string
}

func (w *worker) post(path string, body any) (*http.Response, map[string]any) {
	return w.h.do(w.client, call{method: http.MethodPost, path: "/v1/jobs/" + w.id + path, body: body})
}

type fakeChromium struct {
	mu      sync.Mutex
	started []JobStart
	// behave is what the page does; nil: it finishes at once with "ok"
	behave func(w *worker, ctx context.Context) error
	h      *harness
}

func (f *fakeChromium) run(ctx context.Context, start JobStart) error {
	f.mu.Lock()
	f.started = append(f.started, start)
	behave := f.behave
	f.mu.Unlock()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(start.EnterURL)
	if err != nil {
		return err
	}
	res.Body.Close()
	w := &worker{h: f.h, client: client, id: start.ID}
	if behave == nil {
		w.post("/finish", map[string]any{"result": "ok"})
		return nil
	}
	return behave(w, ctx)
}

func (f *fakeChromium) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.started)
}

func jobsHarness(t *testing.T, generators int) (*harness, *fakeChromium) {
	t.Helper()
	h := newHarness(t)
	fake := &fakeChromium{h: h}
	h.srv.cfg.JobRunner = fake.run
	h.srv.cfg.Generators = generators
	h.srv.cfg.WorkerAppURL = appOrigin
	return h, fake
}

func newJob(t *testing.T, h *harness, client *http.Client, call, fileID string) (int, map[string]any) {
	t.Helper()
	res, body := h.do(client, callArgs(call, fileID))
	return res.StatusCode, body
}

func callArgs(name, fileID string) call {
	return call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": name, "args": []any{fileID, "explanation"}, "fileId": fileID, "title": "Explicação · " + fileID}}
}

func jobOf(t *testing.T, h *harness, client *http.Client, id string) map[string]any {
	t.Helper()
	res, body := h.do(client, call{path: "/v1/jobs/" + id})
	if res.StatusCode != 200 {
		t.Fatalf("job %s: %d %v", id, res.StatusCode, body)
	}
	return body
}

func waitState(t *testing.T, h *harness, client *http.Client, id, state string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		job := jobOf(t, h, client, id)
		if job["state"] == state {
			return job
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s is %v, wanted %s (%v)", id, job["state"], state, job["error"])
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestJobRunsInTheAccountAndGivesBackTheValue(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	fake.behave = func(w *worker, ctx context.Context) error {
		if res, body := w.post("/progress", map[string]any{"message": "Escrevendo a explicação", "fraction": 0.5}); res.StatusCode != 200 {
			t.Errorf("progress %d %v", res.StatusCode, body)
		}
		w.post("/finish", map[string]any{"result": map[string]any{"id": "nota-nova"}})
		return nil
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	status, job := newJob(t, h, client, "generateFromNote", "n1")
	if status != http.StatusAccepted || job["state"] == nil {
		t.Fatalf("create %d %v", status, job)
	}
	done := waitState(t, h, client, job["id"].(string), "done")
	if result, _ := done["result"].(map[string]any); result["id"] != "nota-nova" {
		t.Fatalf("result %v", done["result"])
	}
	if done["finishedAt"] == nil || done["startedAt"] == nil {
		t.Fatalf("times %v", done)
	}
	// the enter address carries a ticket and leads the job's own session to the app's job page
	if !strings.Contains(fake.started[0].EnterURL, "/v1/jobs/"+job["id"].(string)+"/entrar?ticket=") {
		t.Fatalf("enter %s", fake.started[0].EnterURL)
	}
}

// 25/11 ("Explicação: handshake" pronta em Gerações e nunca escrita): "Explicar" and "Gerar desta nota" give the note back at once and
// write it after. The job page sends the note with the progress and the job stays running until the writing ends; the device opens the
// note meanwhile, as when it runs there.
func TestTheNoteGivenBackGoesWithTheProgressWhileTheJobRuns(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	written := make(chan struct{})
	fake.behave = func(w *worker, ctx context.Context) error {
		if res, body := w.post("/progress", map[string]any{"message": "Escrevendo a explicação", "fraction": 0.2, "result": "nota-nova"}); res.StatusCode != 200 {
			t.Errorf("progress %d %v", res.StatusCode, body)
		}
		<-written
		// a later progress without the note keeps the note it gave
		w.post("/progress", map[string]any{"message": "Salvando", "fraction": 0.9})
		w.post("/finish", map[string]any{"result": "nota-nova"})
		return nil
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, client, "generateAta", "n1")
	id := job["id"].(string)
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, now := h.do(client, call{method: http.MethodGet, path: "/v1/jobs/" + id})
		if now["result"] == "nota-nova" {
			if now["state"] != "running" {
				t.Fatalf("with the note given, the job is %v", now["state"])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the note never came with the progress: %v", now)
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(written)
	done := waitState(t, h, client, id, "done")
	if done["result"] != "nota-nova" {
		t.Fatalf("result %v", done["result"])
	}
}

func TestJobRefusals(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	// the job made here stays running until the test ends
	fake.behave = func(w *worker, ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}
	t.Cleanup(func() { h.srv.failJobsOf("", "", "") })
	off, _ := h.account("enabled", false, "sem@exemplo.com")
	if status, body := newJob(t, h, off, "generateFromNote", "n1"); status != http.StatusForbidden {
		t.Fatalf("structure off: %d %v", status, body)
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	res, body := h.do(client, call{method: http.MethodPost, path: "/v1/jobs", body: map[string]any{"call": "window.alert", "args": []any{}, "title": "x"}})
	if res.StatusCode != http.StatusBadRequest || body["error"] != "invalid_call" {
		t.Fatalf("unknown call: %d %v", res.StatusCode, body)
	}
	other, _ := h.account("enabled", true, "outra@exemplo.com")
	_, job := newJob(t, h, client, "generateFromNote", "n1")
	if res, _ := h.do(other, call{path: "/v1/jobs/" + job["id"].(string)}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("other account read %d", res.StatusCode)
	}
	if res, _ := h.do(other, call{method: http.MethodPost, path: "/v1/jobs/" + job["id"].(string) + "/cancel"}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("other account cancel %d", res.StatusCode)
	}
}

func TestOnlyTheJobsOwnSessionReports(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	release := make(chan struct{})
	fake.behave = func(w *worker, ctx context.Context) error {
		<-release
		w.post("/finish", map[string]any{"result": "ok"})
		return nil
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, client, "generateFromNote", "n1")
	id := job["id"].(string)
	waitState(t, h, client, id, "running")
	// the person's own device cannot pretend to be the job
	if res, _ := h.do(client, call{method: http.MethodPost, path: "/v1/jobs/" + id + "/finish", body: map[string]any{"result": "falso"}}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("device finished the job: %d", res.StatusCode)
	}
	// the ticket is used once
	enter := fake.started[0].EnterURL
	if res, err := http.Get(enter); err != nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("ticket used twice: %v %v", res.StatusCode, err)
	}
	close(release)
	waitState(t, h, client, id, "done")
}

func TestJobLimitsAndQueue(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	release := make(chan struct{})
	fake.behave = func(w *worker, ctx context.Context) error {
		select {
		case <-release:
		case <-ctx.Done():
		}
		w.post("/finish", map[string]any{"result": "ok"})
		return nil
	}
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	ids := []string{}
	for _, note := range []string{"a", "b", "c"} {
		status, job := newJob(t, h, ana, "generateFromNote", note)
		if status != http.StatusAccepted {
			t.Fatalf("create %d %v", status, job)
		}
		ids = append(ids, job["id"].(string))
	}
	waitState(t, h, ana, ids[0], "running")
	waitState(t, h, ana, ids[1], "running")
	third := jobOf(t, h, ana, ids[2])
	if third["state"] != "queued" || third["queuePosition"] != float64(1) {
		t.Fatalf("third %v %v", third["state"], third["queuePosition"])
	}
	// the same call of the same note, while it is queued or running, gives back that job
	res, again := h.do(ana, callArgs("generateFromNote", "a"))
	if res.StatusCode != http.StatusConflict || again["error"] != "already_running" || again["job"].(map[string]any)["id"] != ids[0] {
		t.Fatalf("again %d %v", res.StatusCode, again)
	}
	close(release)
	waitState(t, h, ana, ids[2], "done")
	if fake.count() != 3 {
		t.Fatalf("%d runs", fake.count())
	}
}

func TestCancelFromAnotherDeviceStopsTheRun(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	stopped := make(chan struct{})
	fake.behave = func(w *worker, ctx context.Context) error {
		<-ctx.Done()
		close(stopped)
		return ctx.Err()
	}
	one, userID := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, one, "generateFromNote", "n1")
	id := job["id"].(string)
	waitState(t, h, one, id, "running")
	two := h.secondDevice(userID)
	if res, body := h.do(two, call{method: http.MethodPost, path: "/v1/jobs/" + id + "/cancel"}); res.StatusCode != 200 || body["state"] != "cancelled" {
		t.Fatalf("cancel %d %v", res.StatusCode, body)
	}
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("the run did not stop")
	}
	if jobOf(t, h, one, id)["state"] != "cancelled" {
		t.Fatal("a stopped run changed a cancelled job")
	}
}

func TestARunThatDiesFailsAndRetryRunsAgain(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	runs := 0
	fake.behave = func(w *worker, ctx context.Context) error {
		runs++
		if runs == 1 {
			return nil // the Chromium went away without a word
		}
		w.post("/finish", map[string]any{"result": "ok"})
		return nil
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, client, "generateFromNote", "n1")
	id := job["id"].(string)
	failed := waitState(t, h, client, id, "failed")
	if failed["error"] != "O trabalho parou de repente; tente de novo." || failed["errorCode"] != "internal" {
		t.Fatalf("failed %v %v", failed["error"], failed["errorCode"])
	}
	res, retried := h.do(client, call{method: http.MethodPost, path: "/v1/jobs/" + id + "/retry"})
	if res.StatusCode != http.StatusAccepted || retried["attempt"] != float64(2) {
		t.Fatalf("retry %d %v", res.StatusCode, retried)
	}
	waitState(t, h, client, id, "done")
	// a failure reported by the page keeps its reason; dismissing takes it off the list
	fake.behave = func(w *worker, ctx context.Context) error {
		w.post("/fail", map[string]any{"error": "A IA do app está fora do ar agora.", "code": "ai_unavailable"})
		return nil
	}
	_, other := newJob(t, h, client, "generateFromNote", "n2")
	bad := waitState(t, h, client, other["id"].(string), "failed")
	if bad["errorCode"] != "ai_unavailable" {
		t.Fatalf("code %v", bad["errorCode"])
	}
	if res, body := h.do(client, call{method: http.MethodPost, path: "/v1/jobs/" + other["id"].(string) + "/dismiss"}); res.StatusCode != 200 || body["state"] != "dismissed" {
		t.Fatalf("dismiss %d %v", res.StatusCode, body)
	}
}

func TestEstimateAndStall(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	steps := make(chan float64)
	fake.behave = func(w *worker, ctx context.Context) error {
		for fraction := range steps {
			w.post("/progress", map[string]any{"message": "Escrevendo", "fraction": fraction})
		}
		w.post("/finish", map[string]any{"result": "ok"})
		return nil
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, client, "generateFromNote", "n1")
	id := job["id"].(string)
	waitState(t, h, client, id, "running")
	start := h.now
	steps <- 0.2
	// the clock moves only after the first step is in
	for deadline := time.Now().Add(3 * time.Second); jobOf(t, h, client, id)["fraction"] != 0.2; {
		if time.Now().After(deadline) {
			t.Fatal("the first step never came")
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.now = start.Add(2 * time.Minute)
	steps <- 0.4
	// the page reports in its own goroutine: wait until the second step is in
	var got map[string]any
	for deadline := time.Now().Add(3 * time.Second); ; {
		got = jobOf(t, h, client, id)
		if got["fraction"] == 0.4 && got["etaAt"] != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the second step never came: %v", got)
		}
		time.Sleep(10 * time.Millisecond)
	}
	eta, _ := time.Parse(time.RFC3339, got["etaAt"].(string))
	// 0.2 every 2 min, 0.6 left: about 6 min after the last step
	if gap := eta.Sub(h.now); gap < 5*time.Minute || gap > 7*time.Minute || got["etaBasis"] != "parts" {
		t.Fatalf("eta %v (%v) %v", gap, got["etaAt"], got["etaBasis"])
	}
	if got["lastProgress"] != "Escrevendo" || got["stalledSince"] != nil {
		t.Fatalf("progress %v %v", got["lastProgress"], got["stalledSince"])
	}
	// nothing moves for more than twice the normal time of a step
	h.now = h.now.Add(7 * time.Minute)
	h.srv.checkStalls()
	if jobOf(t, h, client, id)["stalledSince"] == nil {
		t.Fatal("no stall after 7 minutes without moving")
	}
	close(steps)
	waitState(t, h, client, id, "done")
}

func TestARunningJobGoesBackToTheQueueAfterARestart(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	client, userID := h.account("enabled", true, "ana@exemplo.com")
	now := stamp(h.now)
	request, _ := json.Marshal(map[string]any{"call": "generateFromNote", "args": []any{"n1"}})
	if _, err := h.db.Exec(`INSERT INTO jobs (id, user_id, call, kind, file_id, title, request, state, attempt, created_at, started_at, updated_at) VALUES ('j-old', ?, 'generateFromNote', 'generateFromNote', 'n1', 'Velho', ?, 'running', 1, ?, ?, ?)`,
		userID, string(request), now, now, now); err != nil {
		t.Fatal(err)
	}
	h.srv.ResumeJobs()
	waitState(t, h, client, "j-old", "done")
	if fake.count() != 1 {
		t.Fatalf("%d runs", fake.count())
	}
}

func TestRevokedAccessFailsTheJobs(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	fake.behave = func(w *worker, ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}
	client, userID := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, client, "generateFromNote", "n1")
	id := job["id"].(string)
	waitState(t, h, client, id, "running")
	h.srv.failJobsOf(userID, "access_revoked", "O acesso desta conta foi retirado.")
	got := jobOf(t, h, client, id)
	if got["state"] != "failed" || got["errorCode"] != "access_revoked" {
		t.Fatalf("%v %v", got["state"], got["errorCode"])
	}
}

func TestJobEventsGoToTheAccountOnly(t *testing.T) {
	h, _ := jobsHarness(t, 2)
	client, userID := h.account("enabled", true, "ana@exemplo.com")
	_, otherID := h.account("enabled", true, "outra@exemplo.com")
	mine := h.listen(userID)
	theirs := h.listen(otherID)
	_, job := newJob(t, h, client, "generateFromNote", "n1")
	waitState(t, h, client, job["id"].(string), "done")
	if !mine.saw("job", job["id"].(string), "done") {
		t.Fatalf("the account did not hear the job: %v", mine.all())
	}
	if theirs.saw("job", job["id"].(string), "") {
		t.Fatal("another account heard the job")
	}
}

// helpers on the harness used only here

func (h *harness) secondDevice(userID string) *http.Client {
	h.t.Helper()
	token := randomToken(32)
	now := time.Now().UTC()
	if _, err := h.db.Exec(`INSERT INTO devices (id, user_id, session_hash, name, created_at, seen_at, expires_at) VALUES (?, ?, ?, 'Outro aparelho', ?, ?, ?)`, newID(), userID, sha256Hex(token), stamp(now), stamp(now), stamp(now.Add(time.Hour))); err != nil {
		h.t.Fatal(err)
	}
	client := h.browser()
	target, _ := url.Parse(h.api.URL)
	client.Jar.SetCookies(target, []*http.Cookie{{Name: sessionCookie, Value: token, Path: "/"}})
	return client
}

type heard struct {
	mu       sync.Mutex
	messages []map[string]any
}

func (l *heard) all() []map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]map[string]any{}, l.messages...)
}

func (l *heard) saw(kind, id, state string) bool {
	for _, message := range l.all() {
		job, _ := message["job"].(map[string]any)
		if message["type"] == kind && job != nil && job["id"] == id && (state == "" || job["state"] == state) {
			return true
		}
	}
	return false
}

// listen hears what the live channel sends to an account, straight from the hub.
func (h *harness) listen(userID string) *heard {
	l := &heard{}
	h.srv.live.watch(userID, func(message any) {
		raw, _ := json.Marshal(message)
		var parsed map[string]any
		_ = json.Unmarshal(raw, &parsed)
		l.mu.Lock()
		l.messages = append(l.messages, parsed)
		l.mu.Unlock()
	})
	return l
}

// T062: the job page talks to the app's AI (spec 006) as the account, with the job's session.
func TestTheJobSessionReachesTheAppsAI(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	seen := make(chan int, 1)
	fake.behave = func(w *worker, ctx context.Context) error {
		res, _ := w.h.do(w.client, call{path: "/v1/ai/config"})
		seen <- res.StatusCode
		w.post("/finish", map[string]any{"result": "ok"})
		return nil
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, client, "generateFromNote", "n1")
	if status := <-seen; status != http.StatusOK {
		t.Fatalf("the job's session got %d from the app's AI", status)
	}
	waitState(t, h, client, job["id"].(string), "done")
}

// FR-031 (spec 007): the transcription and the Ata of the same recording are asked together, and the Ata needs the transcript: the
// jobs of one note run one after the other, in the order they came, while the other notes' jobs go on.
func TestJobsOfTheSameNoteRunInTurn(t *testing.T) {
	h, fake := jobsHarness(t, 4)
	release := make(chan struct{})
	fake.behave = func(w *worker, ctx context.Context) error {
		select {
		case <-release:
		case <-ctx.Done():
		}
		w.post("/finish", map[string]any{"result": "ok"})
		return nil
	}
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	_, transcription := newJob(t, h, ana, "transcribeNote", "gravacao")
	_, ata := newJob(t, h, ana, "generateAta", "gravacao")
	_, other := newJob(t, h, ana, "generateFromNote", "outra")
	waitState(t, h, ana, transcription["id"].(string), "running")
	waitState(t, h, ana, other["id"].(string), "running")
	if state := jobOf(t, h, ana, ata["id"].(string))["state"]; state != "queued" {
		t.Fatalf("the Ata of the same note is %v while its transcription runs", state)
	}
	close(release)
	waitState(t, h, ana, ata["id"].(string), "done")
}

// "Ainda não transcreve" (dono, 24/11): a job whose page did not open on the server, or opened and died before saying anything, stayed
// "running" for the 3 hours of jobMaxRun, holding one of the generators and every other job of the same note. Now it fails with the reason
// and leaves its place.
func TestAPageThatNeverEntersFailsWithTheReason(t *testing.T) {
	h, _ := jobsHarness(t, 2)
	stopped := make(chan struct{})
	h.srv.cfg.JobRunner = func(ctx context.Context, start JobStart) error {
		<-ctx.Done()
		close(stopped)
		return ctx.Err()
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, client, "transcribeNote", "n1")
	id := job["id"].(string)
	waitState(t, h, client, id, "running")
	h.now = h.now.Add(jobTicketTTL + time.Minute)
	h.srv.checkStalls()
	got := waitState(t, h, client, id, "failed")
	if !strings.Contains(got["error"].(string), "não abriu") {
		t.Fatalf("motivo %v", got["error"])
	}
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("o Chromium do trabalho não foi parado")
	}
}

func TestAPageThatEntersAndNeverSaysAnythingFails(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	entered := make(chan struct{})
	fake.behave = func(w *worker, ctx context.Context) error {
		close(entered)
		<-ctx.Done()
		return ctx.Err()
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, client, "transcribeNote", "n1")
	id := job["id"].(string)
	waitState(t, h, client, id, "running")
	// the clock moves only after the page is in (the fake enters in its own goroutine)
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("a página não entrou")
	}
	// a page that is working but quiet for a while is not stopped
	h.now = h.now.Add(jobSilentStart - time.Minute)
	h.srv.checkStalls()
	if state := jobOf(t, h, client, id)["state"]; state != "running" {
		t.Fatalf("parado cedo demais: %v", state)
	}
	h.now = h.now.Add(2 * time.Minute)
	h.srv.checkStalls()
	got := waitState(t, h, client, id, "failed")
	if !strings.Contains(got["error"].(string), "não deu notícia") {
		t.Fatalf("motivo %v", got["error"])
	}
}

func TestAPageThatReportedIsOnlyMarkedStalled(t *testing.T) {
	h, fake := jobsHarness(t, 2)
	fake.behave = func(w *worker, ctx context.Context) error {
		w.post("/progress", map[string]any{"message": "Transcrevendo pela DeepInfra", "fraction": 0.1})
		<-ctx.Done()
		return ctx.Err()
	}
	client, _ := h.account("enabled", true, "ana@exemplo.com")
	_, job := newJob(t, h, client, "transcribeNote", "n1")
	id := job["id"].(string)
	waitState(t, h, client, id, "running")
	for deadline := time.Now().Add(3 * time.Second); jobOf(t, h, client, id)["lastProgress"] == nil; {
		if time.Now().After(deadline) {
			t.Fatal("o andamento não chegou")
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.now = h.now.Add(jobSilentStart + 10*time.Minute)
	h.srv.checkStalls()
	got := jobOf(t, h, client, id)
	if got["state"] != "running" || got["stalledSince"] == nil {
		t.Fatalf("um trabalho que já deu notícia só fica marcado parado: %v %v", got["state"], got["stalledSince"])
	}
}

// T190 (dono, 27/11: "Corrija tudo"): the queue had 2 places for everything, so a quick text job could wait behind long media jobs; and two
// media jobs of long videos at once do not fit the server (3,8 GB: each one decodes its video and its audio). A job that may open the media
// of its note (transcribe, read the screen, send it to the model) runs in the media lane, one at a time by default; the others use the rest.

// mediaNote is a note of the account that keeps its media in the App.
func mediaNote(t *testing.T, h *harness, userID, id string) {
	t.Helper()
	if _, err := h.db.Exec(`INSERT INTO library_items (user_id, id, item_kind, note_type, name, place, position, meta, media, media_bytes, created_at, updated_at, rev, seq) VALUES (?, ?, 'file', 'video', 'Reunião', 'app', 0, '{}', '{"id":"m1","key":"k","mime":"video/webm","bytes":10}', 10, '2026-11-27T10:00:00Z', '2026-11-27T10:00:00Z', 1, 1)`, userID, id); err != nil {
		t.Fatal(err)
	}
}

func blockUntil(release chan struct{}) func(w *worker, ctx context.Context) error {
	return func(w *worker, ctx context.Context) error {
		select {
		case <-release:
		case <-ctx.Done():
		}
		w.post("/finish", map[string]any{"result": "ok"})
		return nil
	}
}

func TestMediaJobsRunOneAtATimeAndTextJobsDoNotWaitForThem(t *testing.T) {
	h, fake := jobsHarness(t, 0)
	release := make(chan struct{})
	fake.behave = blockUntil(release)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	bia, biaID := h.account("enabled", true, "bia@exemplo.com")
	mediaNote(t, h, anaID, "gravacao-ana")
	mediaNote(t, h, biaID, "gravacao-bia")
	_, first := newJob(t, h, ana, "transcribeNote", "gravacao-ana")
	_, second := newJob(t, h, bia, "generateAta", "gravacao-bia")
	_, text := newJob(t, h, bia, "generateAta", "texto-bia")
	_, other := newJob(t, h, ana, "generateFromNote", "nota-de-texto")
	waitState(t, h, ana, first["id"].(string), "running")
	// the text jobs start beside the media job, even the one that arrived after the media job that waits
	waitState(t, h, bia, text["id"].(string), "running")
	waitState(t, h, ana, other["id"].(string), "running")
	waiting := jobOf(t, h, bia, second["id"].(string))
	if waiting["state"] != "queued" || waiting["queuePosition"] != float64(1) {
		t.Fatalf("the second media job is %v (position %v) while the first runs", waiting["state"], waiting["queuePosition"])
	}
	close(release)
	waitState(t, h, bia, second["id"].(string), "done")
}

func TestTheServerTakesAtMostThreeJobsAtOnceByDefault(t *testing.T) {
	h, fake := jobsHarness(t, 0)
	release := make(chan struct{})
	fake.behave = blockUntil(release)
	ana, _ := h.account("enabled", true, "ana@exemplo.com")
	bia, _ := h.account("enabled", true, "bia@exemplo.com")
	ids := map[string]*http.Client{}
	for _, item := range []struct {
		client *http.Client
		note   string
	}{{ana, "a"}, {ana, "b"}, {bia, "c"}, {bia, "d"}} {
		_, job := newJob(t, h, item.client, "generateFromNote", item.note)
		ids[job["id"].(string)] = item.client
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var running, queued int
		_ = h.db.QueryRow(`SELECT COALESCE(SUM(state = 'running'), 0), COALESCE(SUM(state = 'queued'), 0) FROM jobs`).Scan(&running, &queued)
		if running == 3 && queued == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d running and %d queued, wanted 3 and 1", running, queued)
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(release)
	for id, client := range ids {
		waitState(t, h, client, id, "done")
	}
}

func TestTheQueuePositionCountsOnlyTheJobsOfTheSameLane(t *testing.T) {
	h, fake := jobsHarness(t, 0)
	release := make(chan struct{})
	fake.behave = blockUntil(release)
	ana, anaID := h.account("enabled", true, "ana@exemplo.com")
	bia, biaID := h.account("enabled", true, "bia@exemplo.com")
	mediaNote(t, h, biaID, "gravacao-bia")
	mediaNote(t, h, anaID, "gravacao-ana")
	mediaNote(t, h, anaID, "outra-gravacao")
	_, running := newJob(t, h, bia, "transcribeNote", "gravacao-bia")
	waitState(t, h, bia, running["id"].(string), "running")
	_, media := newJob(t, h, ana, "transcribeNote", "gravacao-ana")
	_, more := newJob(t, h, ana, "generateAta", "outra-gravacao")
	if position := jobOf(t, h, ana, more["id"].(string))["queuePosition"]; position != float64(2) {
		t.Fatalf("the second media job of the queue is at %v", position)
	}
	if position := jobOf(t, h, ana, media["id"].(string))["queuePosition"]; position != float64(1) {
		t.Fatalf("the first media job of the queue is at %v", position)
	}
	close(release)
	waitState(t, h, ana, more["id"].(string), "done")
}
