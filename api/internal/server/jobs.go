package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Generating in the account (spec 007, história 2, research R10b; contracts/api-jobs.md, live-events.md). The service keeps a queue of
// jobs; for each one it opens the app itself in a headless Chromium, entering with a ticket of one use that gives the page a session of
// that job only. The page (/trabalho/<id>) runs the same call of the generations store the device would, with the account's App and the
// app's AI, reports its progress every second and, at the end, the value the call gave back (the new note's id, the map made), which goes
// back to whoever asked. The device leaves the heavy work and can close the tab.

const (
	// how long a step normally goes without moving; past twice this, the job is stalled (FR-063)
	jobNormalStep = 3 * time.Minute
	jobTicketTTL  = 5 * time.Minute
	jobMaxRun     = 3 * time.Hour
	// up to this many jobs of one account run at the same time (FR-015)
	jobsPerAccount = 2
	// T190: places on the server when ESTUDO_GERADORES (all jobs) and ESTUDO_GERADORES_MIDIA (the media lane) are not set. Each job is a
	// Chromium of about 420 MB (measured, e2e/playwright.trabalho.config.ts); a media job also decodes its video and its audio, and two of
	// a long video do not fit the 3,8 GB of the server: one at a time, and the text jobs use the other places.
	defaultGenerators      = 3
	defaultMediaGenerators = 1
	jobsKeptDays           = 30
	jobDiedMessage         = "O trabalho parou de repente; tente de novo."
	// a page that entered and said nothing at all for this long died before its first step (the worker reports within a second of starting)
	jobSilentStart    = 10 * time.Minute
	jobNeverOpened    = "A página do trabalho não abriu no servidor; tente de novo."
	jobNeverSaidStart = "O trabalho abriu e não deu notícia em 10 minutos; tente de novo."
)

// jobCalls are the calls of the generations store (src/stores/jobs.ts) a job may make; nothing else runs.
var jobCalls = map[string]bool{
	"generateFromNote": true, "generateAta": true, "generatePending": true, "generateSecondTab": true, "redoTranscript": true,
	"transcribeNote": true, "createQuestions": true, "generateArtifact": true, "generateRemaining": true, "explainSelection": true,
	"generateFromSelection": true, "regenerate": true, "suggestTags": true,
}

// JobStart is what the runner of a job needs: where the page enters.
type JobStart struct {
	ID       string
	UserID   string
	EnterURL string
}

type jobRow struct {
	ID, UserID, Call, Kind, Title, State string
	FileID, Stage, EtaAt, EtaBasis       *string
	LastProgressAt, LastProgress         *string
	StalledSince, Error, ErrorCode       *string
	DeviceID, StartedAt, FinishedAt      *string
	Fraction                             *float64
	Request, Result                      json.RawMessage
	Attempt                              int
	CreatedAt                            string
}

const jobColumns = `id, user_id, call, kind, file_id, title, request, state, stage, fraction, eta_at, eta_basis, last_progress_at, last_progress, stalled_since, result, error, error_code, attempt, device_id, created_at, started_at, finished_at`

func scanJob(row scanner) (*jobRow, error) {
	var job jobRow
	var fileID, stage, etaAt, etaBasis, lastAt, last, stalled, result, errText, errCode, device, started, finished sql.NullString
	var fraction sql.NullFloat64
	var request string
	if err := row.Scan(&job.ID, &job.UserID, &job.Call, &job.Kind, &fileID, &job.Title, &request, &job.State, &stage, &fraction, &etaAt, &etaBasis, &lastAt, &last, &stalled,
		&result, &errText, &errCode, &job.Attempt, &device, &job.CreatedAt, &started, &finished); err != nil {
		return nil, err
	}
	str := func(value sql.NullString) *string {
		if !value.Valid {
			return nil
		}
		return &value.String
	}
	job.FileID, job.Stage, job.EtaAt, job.EtaBasis, job.LastProgressAt, job.LastProgress = str(fileID), str(stage), str(etaAt), str(etaBasis), str(lastAt), str(last)
	job.StalledSince, job.Error, job.ErrorCode, job.DeviceID, job.StartedAt, job.FinishedAt = str(stalled), str(errText), str(errCode), str(device), str(started), str(finished)
	if fraction.Valid {
		job.Fraction = &fraction.Float64
	}
	job.Request = json.RawMessage(request)
	if result.Valid {
		job.Result = json.RawMessage(result.String)
	}
	return &job, nil
}

// jobsState is what the service keeps in memory about the jobs running here.
type jobsState struct {
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
	paces   map[string]*jobPace
	wake    chan struct{}
}

// jobPace is the moving average of the time per unit of fraction (recent steps count more).
type jobPace struct {
	at       time.Time
	fraction float64
	perUnit  time.Duration
}

func newJobsState() *jobsState {
	return &jobsState{cancels: map[string]context.CancelFunc{}, paces: map[string]*jobPace{}, wake: make(chan struct{}, 1)}
}

func (srv *Server) wakeJobs() {
	select {
	case srv.jobs.wake <- struct{}{}:
	default:
	}
}

// jobLoop starts what fits whenever something changes, and looks for stalled jobs every 30 s.
func (srv *Server) jobLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-srv.jobs.wake:
			srv.dispatchJobs()
		case <-ticker.C:
			srv.checkStalls()
			srv.dispatchJobs()
		}
	}
}

// ResumeJobs puts back in the queue what was running when the service stopped: its Chromium died with it, so it runs again.
func (srv *Server) ResumeJobs() {
	if _, err := srv.db.Exec(`UPDATE jobs SET state = 'queued', started_at = NULL, device_id = NULL, ticket_hash = NULL, ticket_expires_at = NULL, stage = NULL,
		fraction = NULL, eta_at = NULL, eta_basis = NULL, last_progress_at = NULL, last_progress = NULL, stalled_since = NULL, updated_at = ? WHERE state = 'running'`, ts(srv.now())); err != nil {
		log.Printf("jobs: resume: %v", err)
	}
	srv.wakeJobs()
}

func (srv *Server) generators() int {
	if srv.cfg.Generators > 0 {
		return srv.cfg.Generators
	}
	return defaultGenerators
}

// mediaGenerators is how many jobs of the media lane run at once, never more than all the places.
func (srv *Server) mediaGenerators() int {
	media := defaultMediaGenerators
	if srv.cfg.MediaGenerators > 0 {
		media = srv.cfg.MediaGenerators
	}
	return min(media, srv.generators())
}

// mediaLane is true (1) for the job `j` that may open the media of its note: a transcription, an Ata, or a note generated from a note that
// keeps its media in the App (to transcribe it first, read its screen or send it to the model). Everything else is text (T190).
const mediaLane = `(j.call IN ('transcribeNote', 'generateAta', 'generateFromNote') AND EXISTS (SELECT 1 FROM library_items i WHERE i.user_id = j.user_id AND i.id = j.file_id AND i.media IS NOT NULL))`

func (srv *Server) dispatchJobs() {
	rows, err := srv.db.Query(`SELECT j.id, j.user_id, COALESCE(j.file_id, ''), ` + mediaLane + ` FROM jobs j WHERE j.state = 'queued' ORDER BY j.rowid`)
	if err != nil {
		return
	}
	type waiting struct {
		id, user, file string
		media          bool
	}
	var queue []waiting
	for rows.Next() {
		var item waiting
		if rows.Scan(&item.id, &item.user, &item.file, &item.media) == nil {
			queue = append(queue, item)
		}
	}
	rows.Close()
	for _, item := range queue {
		var total, media, mine, sameNote int
		_ = srv.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(`+mediaLane+`), 0), COALESCE(SUM(j.user_id = ?), 0), COALESCE(SUM(j.user_id = ? AND j.file_id = ? AND ? != ''), 0) FROM jobs j WHERE j.state = 'running'`,
			item.user, item.user, item.file, item.file).Scan(&total, &media, &mine, &sameNote)
		if total >= srv.generators() {
			return
		}
		// the jobs of one note run in turn (FR-031): the Ata of a recording starts after its transcription; a media job waits for its lane,
		// and the text jobs behind it go on
		if mine >= jobsPerAccount || sameNote > 0 || (item.media && media >= srv.mediaGenerators()) {
			continue
		}
		srv.startJob(item.id, item.user)
	}
}

func (srv *Server) startJob(id, userID string) {
	token := randomToken(32)
	now := srv.now()
	res, err := srv.db.Exec(`UPDATE jobs SET state = 'running', started_at = ?, ticket_hash = ?, ticket_expires_at = ?, device_id = NULL, updated_at = ? WHERE id = ? AND state = 'queued'`,
		ts(now), sha256Hex(token), ts(now.Add(jobTicketTTL)), ts(now), id)
	if err != nil {
		return
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		return
	}
	srv.jobs.mu.Lock()
	delete(srv.jobs.paces, id)
	ctx, cancel := context.WithTimeout(context.Background(), jobMaxRun)
	srv.jobs.cancels[id] = cancel
	srv.jobs.mu.Unlock()
	srv.notifyJob(userID, id)
	start := JobStart{ID: id, UserID: userID, EnterURL: strings.TrimRight(srv.cfg.PublicURL, "/") + "/v1/jobs/" + id + "/entrar?ticket=" + token}
	runner := srv.cfg.JobRunner
	if runner == nil {
		runner = srv.runChromium
	}
	// T206 (FR-084): a transcription the backend in Go can make runs here, without the Chromium
	if plan := srv.goTranscriptionOf(id, userID); plan != nil {
		runner = func(ctx context.Context, start JobStart) error { return srv.runGoTranscription(ctx, start, plan) }
	}
	// T207: a generation already in Go runs here too
	if run := srv.goGenerationOf(id, userID); run != nil {
		runner = run
	}
	go func() {
		err := runner(ctx, start)
		cancel()
		srv.jobs.mu.Lock()
		delete(srv.jobs.cancels, id)
		srv.jobs.mu.Unlock()
		// the page went away without saying the end: a failure, with "Tentar de novo"
		if res, _ := srv.db.Exec(`UPDATE jobs SET state = 'failed', error = ?, error_code = 'internal', finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'`,
			jobDiedMessage, ts(srv.now()), ts(srv.now()), id); res != nil {
			if changed, _ := res.RowsAffected(); changed > 0 {
				if err != nil && !errors.Is(err, context.Canceled) {
					log.Printf("jobs: %s ended: %v", id, err)
				}
				srv.notifyJob(userID, id)
			}
		}
		srv.wakeJobs()
	}()
}

// runChromium opens the app of the job in a headless Chromium, with a new profile, until the page says the end (then the job's context
// is cancelled and the process goes) or the time limit.
func (srv *Server) runChromium(ctx context.Context, start JobStart) error {
	profile, err := os.MkdirTemp("", "estudo-trabalho-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(profile)
	path := srv.cfg.ChromiumPath
	if path == "" {
		path = "chromium"
	}
	// --enable-logging=stderr: the console of the app's page (its errors, the reason a call failed) comes out with Chromium's own lines
	args := []string{"--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
		"--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--enable-logging=stderr", "--v=0",
		"--user-data-dir=" + profile}
	if srv.cfg.ChromiumHosts != "" {
		args = append(args, "--host-resolver-rules="+srv.cfg.ChromiumHosts)
	}
	cmd := exec.CommandContext(ctx, path, append(args, start.EnterURL)...)
	cmd.WaitDelay = 5 * time.Second
	out := &jobLog{srv: srv, id: start.ID}
	cmd.Stdout, cmd.Stderr = out, out
	err = cmd.Run()
	out.flush()
	return err
}

// What the jobs' Chromium writes goes to the service's log (24/11: a job that failed or never ended in production left no trace): line
// by line with the job's id, at most chromiumLogLines lines of chromiumLineMax bytes per job, and never the ticket of the job's page.
const (
	chromiumLogLines = 300
	chromiumLineMax  = 1000
)

var ticketInLog = regexp.MustCompile(`ticket=[^&\s"']+`)

type jobLog struct {
	srv     *Server
	id      string
	mu      sync.Mutex
	pending []byte
	lines   int
}

func (l *jobLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pending = append(l.pending, p...)
	for {
		end := bytes.IndexByte(l.pending, '\n')
		if end < 0 {
			break
		}
		l.line(string(l.pending[:end]))
		l.pending = l.pending[end+1:]
	}
	return len(p), nil
}

func (l *jobLog) flush() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.line(string(l.pending))
	l.pending = nil
}

func (l *jobLog) line(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	l.lines++
	if l.lines > chromiumLogLines {
		if l.lines == chromiumLogLines+1 {
			l.srv.logf("jobs: %s chromium: (o resto foi cortado)", l.id)
		}
		return
	}
	text = ticketInLog.ReplaceAllString(text, "ticket=…")
	if len(text) > chromiumLineMax {
		text = strings.ToValidUTF8(text[:chromiumLineMax], "") + "…"
	}
	l.srv.logf("jobs: %s chromium: %s", l.id, text)
}

func (srv *Server) logf(format string, args ...any) {
	if srv.cfg.Logf != nil {
		srv.cfg.Logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

func (srv *Server) cancelRun(id string) {
	srv.jobs.mu.Lock()
	cancel := srv.jobs.cancels[id]
	srv.jobs.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (srv *Server) findJob(id, userID string) (*jobRow, error) {
	job, err := scanJob(srv.db.QueryRow(`SELECT `+jobColumns+` FROM jobs WHERE id = ? AND user_id = ?`, id, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return job, err
}

// jobOut is a job as the API shows it.
func (srv *Server) jobOut(job *jobRow) map[string]any {
	var args any = []any{}
	var request struct {
		Args json.RawMessage `json:"args"`
	}
	if json.Unmarshal(job.Request, &request) == nil && len(request.Args) > 0 {
		args = request.Args
	}
	var result any
	if len(job.Result) > 0 {
		result = job.Result
	}
	out := map[string]any{
		"id": job.ID, "call": job.Call, "kind": job.Kind, "fileId": job.FileID, "title": job.Title, "state": job.State, "queuePosition": nil,
		"stage": job.Stage, "fraction": job.Fraction, "etaAt": job.EtaAt, "etaBasis": job.EtaBasis, "lastProgress": job.LastProgress,
		"lastProgressAt": job.LastProgressAt, "stalledSince": job.StalledSince, "args": args, "result": result, "error": job.Error,
		"errorCode": job.ErrorCode, "attempt": job.Attempt, "createdAt": job.CreatedAt, "startedAt": job.StartedAt, "finishedAt": job.FinishedAt,
	}
	if job.State == "queued" {
		var ahead int
		// the order of arrival (rowid), the same order the queue starts them, among the jobs of the same lane (T190)
		_ = srv.db.QueryRow(`SELECT COUNT(*) FROM jobs j, jobs me WHERE me.id = ? AND j.user_id = me.user_id AND j.state = 'queued' AND j.rowid < me.rowid
			AND `+mediaLane+` = (SELECT `+strings.ReplaceAll(mediaLane, "j.", "me.")+`)`, job.ID).Scan(&ahead)
		out["queuePosition"] = ahead + 1
	}
	return out
}

func (srv *Server) notifyJob(userID, id string) {
	job, err := srv.findJob(id, userID)
	if err != nil || job == nil {
		return
	}
	srv.live.send(userID, map[string]any{"type": "job", "job": srv.jobOut(job)})
}

func (srv *Server) createJob(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Call   string          `json:"call"`
		Args   json.RawMessage `json:"args"`
		FileID string          `json:"fileId"`
		Title  string          `json:"title"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	if !jobCalls[body.Call] {
		fail(w, http.StatusBadRequest, "invalid_call", nil)
		return
	}
	if len(body.Args) == 0 {
		body.Args = json.RawMessage("[]")
	}
	if strings.TrimSpace(body.Title) == "" {
		body.Title = body.Call
	}
	if body.FileID != "" {
		existing, err := scanJob(srv.db.QueryRow(`SELECT `+jobColumns+` FROM jobs WHERE user_id = ? AND call = ? AND file_id = ? AND state IN ('queued', 'running') ORDER BY created_at LIMIT 1`, s.User.ID, body.Call, body.FileID))
		if err == nil {
			fail(w, http.StatusConflict, "already_running", map[string]any{"job": srv.jobOut(existing)})
			return
		}
	}
	request, _ := json.Marshal(map[string]any{"call": body.Call, "args": body.Args})
	id := newID()
	now := ts(srv.now())
	var fileID any
	if body.FileID != "" {
		fileID = body.FileID
	}
	if _, err := srv.db.Exec(`INSERT INTO jobs (id, user_id, call, kind, file_id, title, request, state, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)`,
		id, s.User.ID, body.Call, body.Call, fileID, body.Title, string(request), now, now); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.wakeJobs()
	job, _ := srv.findJob(id, s.User.ID)
	srv.notifyJob(s.User.ID, id)
	writeJSON(w, http.StatusAccepted, srv.jobOut(job))
}

func (srv *Server) listJobs(w http.ResponseWriter, r *http.Request, s *Session) {
	since := ts(srv.now().Add(-7 * 24 * time.Hour))
	rows, err := srv.db.Query(`SELECT `+jobColumns+` FROM jobs WHERE user_id = ? AND state != 'dismissed' AND (state IN ('queued', 'running') OR created_at >= ?)
		ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, created_at DESC`, s.User.ID, since)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	var jobs []*jobRow
	for rows.Next() {
		if job, err := scanJob(rows); err == nil {
			jobs = append(jobs, job)
		}
	}
	rows.Close()
	list := make([]map[string]any, 0, len(jobs))
	for _, job := range jobs {
		list = append(list, srv.jobOut(job))
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": list})
}

func (srv *Server) getJob(w http.ResponseWriter, r *http.Request, s *Session) {
	job, err := srv.findJob(r.PathValue("id"), s.User.ID)
	if err != nil || job == nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return
	}
	writeJSON(w, http.StatusOK, srv.jobOut(job))
}

// changeJob moves a job from one of `from` to `to` (with the extra columns); it gives back the job after, or answers itself.
func (srv *Server) changeJob(w http.ResponseWriter, r *http.Request, s *Session, from []string, to string, refusal string, set string, args ...any) *jobRow {
	job, err := srv.findJob(r.PathValue("id"), s.User.ID)
	if err != nil || job == nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return nil
	}
	allowed := false
	for _, state := range from {
		allowed = allowed || job.State == state
	}
	if !allowed {
		fail(w, http.StatusConflict, refusal, map[string]any{"job": srv.jobOut(job)})
		return nil
	}
	query := `UPDATE jobs SET state = ?, updated_at = ?` + set + ` WHERE id = ? AND state = ?`
	values := append([]any{to, ts(srv.now())}, args...)
	values = append(values, job.ID, job.State)
	if _, err := srv.db.Exec(query, values...); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return nil
	}
	after, _ := srv.findJob(job.ID, s.User.ID)
	srv.notifyJob(s.User.ID, job.ID)
	return after
}

func (srv *Server) cancelJob(w http.ResponseWriter, r *http.Request, s *Session) {
	job := srv.changeJob(w, r, s, []string{"queued", "running"}, "cancelled", "already_finished", `, finished_at = ?, error_code = 'cancelled'`, ts(srv.now()))
	if job == nil {
		return
	}
	srv.cancelRun(job.ID)
	srv.wakeJobs()
	writeJSON(w, http.StatusOK, srv.jobOut(job))
}

func (srv *Server) retryJob(w http.ResponseWriter, r *http.Request, s *Session) {
	job := srv.changeJob(w, r, s, []string{"failed", "cancelled"}, "queued", "not_failed",
		`, attempt = attempt + 1, error = NULL, error_code = NULL, result = NULL, stage = NULL, fraction = NULL, eta_at = NULL, eta_basis = NULL, last_progress_at = NULL,
		last_progress = NULL, stalled_since = NULL, started_at = NULL, finished_at = NULL, device_id = NULL, ticket_hash = NULL`)
	if job == nil {
		return
	}
	srv.wakeJobs()
	writeJSON(w, http.StatusAccepted, srv.jobOut(job))
}

func (srv *Server) dismissJob(w http.ResponseWriter, r *http.Request, s *Session) {
	job := srv.changeJob(w, r, s, []string{"failed"}, "dismissed", "not_failed", "")
	if job == nil {
		return
	}
	writeJSON(w, http.StatusOK, srv.jobOut(job))
}

// enterJob: the Chromium of a job enters with its ticket, once; the session it gets is of that job only, and it lands on the job page.
func (srv *Server) enterJob(w http.ResponseWriter, r *http.Request, _ *Session) {
	id, ticket := r.PathValue("id"), r.URL.Query().Get("ticket")
	var userID string
	err := srv.db.QueryRow(`SELECT user_id FROM jobs WHERE id = ? AND state = 'running' AND ticket_hash = ? AND ticket_expires_at > ?`, id, sha256Hex(ticket), ts(srv.now())).Scan(&userID)
	if ticket == "" || err != nil {
		fail(w, http.StatusForbidden, "ticket_refused", nil)
		return
	}
	token := randomToken(32)
	deviceID := newID()
	now := srv.now()
	if _, err := srv.db.Exec(`INSERT INTO devices (id, user_id, session_hash, name, created_at, seen_at, expires_at) VALUES (?, ?, ?, 'Gerador no servidor', ?, ?, ?)`,
		deviceID, userID, sha256Hex(token), stamp(now), stamp(now), stamp(now.Add(24*time.Hour))); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	if _, err := srv.db.Exec(`UPDATE jobs SET ticket_hash = NULL, ticket_expires_at = NULL, device_id = ?, updated_at = ? WHERE id = ?`, deviceID, ts(now), id); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", MaxAge: 24 * 3600, HttpOnly: true, Secure: srv.cfg.SecureCookies, SameSite: http.SameSiteLaxMode})
	target := srv.cfg.WorkerAppURL
	if target == "" {
		target = srv.cfg.AppOrigin
	}
	http.Redirect(w, r, strings.TrimRight(target, "/")+"/trabalho/"+id, http.StatusFound)
}

// ownRunning is the job the page of this session runs; anything else is refused.
func (srv *Server) ownRunning(w http.ResponseWriter, r *http.Request, s *Session) *jobRow {
	job, err := srv.findJob(r.PathValue("id"), s.User.ID)
	if err != nil || job == nil {
		fail(w, http.StatusNotFound, "not_found", nil)
		return nil
	}
	if job.DeviceID == nil || *job.DeviceID != s.DeviceID {
		fail(w, http.StatusForbidden, "not_the_job", nil)
		return nil
	}
	if job.State != "running" {
		fail(w, http.StatusConflict, "not_running", map[string]any{"state": job.State})
		return nil
	}
	return job
}

func (srv *Server) progressJob(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Message  string   `json:"message"`
		Fraction *float64 `json:"fraction"`
		// the note a call gave back at once while its writing goes on ("Explicar", "Gerar desta nota", 25/11): the device opens it now
		Result json.RawMessage `json:"result"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	job := srv.ownRunning(w, r, s)
	if job == nil {
		return
	}
	now := srv.now()
	var fraction any
	if body.Fraction != nil {
		value := min(1, max(0, *body.Fraction))
		body.Fraction = &value
		fraction = value
	}
	etaAt, basis := srv.estimate(job, body.Fraction, now)
	var eta, etaBasis any
	if etaAt != nil {
		eta, etaBasis = ts(*etaAt), basis
	}
	moved := job.LastProgress == nil || *job.LastProgress != body.Message || (body.Fraction != nil && (job.Fraction == nil || *job.Fraction != *body.Fraction))
	lastAt := job.LastProgressAt
	if moved {
		value := ts(now)
		lastAt = &value
	}
	var result any
	if len(body.Result) > 0 && string(body.Result) != "null" {
		result = string(body.Result)
	}
	if _, err := srv.db.Exec(`UPDATE jobs SET stage = ?, fraction = ?, eta_at = ?, eta_basis = ?, last_progress = ?, last_progress_at = ?, stalled_since = CASE WHEN ? THEN NULL ELSE stalled_since END, result = COALESCE(?, result), updated_at = ? WHERE id = ?`,
		body.Message, fraction, eta, etaBasis, body.Message, lastAt, moved, result, ts(now), job.ID); err != nil {
		fail(w, http.StatusInternalServerError, "internal_error", nil)
		return
	}
	srv.notifyJob(s.User.ID, job.ID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// estimate: by the pace of the fraction (a moving average, recent steps count more), or, before it moves, by the last similar jobs.
func (srv *Server) estimate(job *jobRow, fraction *float64, now time.Time) (*time.Time, string) {
	srv.jobs.mu.Lock()
	pace := srv.jobs.paces[job.ID]
	if fraction != nil {
		switch {
		case pace == nil:
			srv.jobs.paces[job.ID] = &jobPace{at: now, fraction: *fraction}
			pace = srv.jobs.paces[job.ID]
		case *fraction > pace.fraction && now.After(pace.at):
			per := time.Duration(float64(now.Sub(pace.at)) / (*fraction - pace.fraction))
			if pace.perUnit == 0 {
				pace.perUnit = per
			} else {
				pace.perUnit = (per + pace.perUnit) / 2
			}
			pace.at, pace.fraction = now, *fraction
		}
	}
	var perUnit time.Duration
	var done float64
	if pace != nil {
		perUnit, done = pace.perUnit, pace.fraction
	}
	srv.jobs.mu.Unlock()
	if perUnit > 0 {
		eta := now.Add(time.Duration(float64(perUnit) * (1 - done)))
		return &eta, "parts"
	}
	// before it moves: the median of the last 20 of the same call of this account
	rows, err := srv.db.Query(`SELECT started_at, finished_at FROM jobs WHERE user_id = ? AND kind = ? AND state = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 20`, job.UserID, job.Kind)
	if err != nil {
		return nil, ""
	}
	var spans []time.Duration
	for rows.Next() {
		var started, finished string
		if rows.Scan(&started, &finished) == nil {
			from, err1 := time.Parse(time.RFC3339, started)
			to, err2 := time.Parse(time.RFC3339, finished)
			if err1 == nil && err2 == nil && to.After(from) {
				spans = append(spans, to.Sub(from))
			}
		}
	}
	rows.Close()
	if len(spans) == 0 || job.StartedAt == nil {
		return nil, ""
	}
	var total time.Duration
	for _, span := range spans {
		total += span
	}
	from, err := time.Parse(time.RFC3339, *job.StartedAt)
	if err != nil {
		return nil, ""
	}
	eta := from.Add(total / time.Duration(len(spans)))
	if eta.Before(now) {
		return nil, ""
	}
	return &eta, "history"
}

func (srv *Server) finishJob(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Result json.RawMessage `json:"result"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	job := srv.ownRunning(w, r, s)
	if job == nil {
		return
	}
	var result any
	if len(body.Result) > 0 {
		result = string(body.Result)
	}
	srv.endJob(job, s, `state = 'done', result = ?, fraction = 1, stalled_since = NULL`, result)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (srv *Server) failJob(w http.ResponseWriter, r *http.Request, s *Session) {
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if !readJSON(r, &body) {
		fail(w, http.StatusBadRequest, "invalid_body", nil)
		return
	}
	job := srv.ownRunning(w, r, s)
	if job == nil {
		return
	}
	if strings.TrimSpace(body.Error) == "" {
		body.Error = jobDiedMessage
	}
	if body.Code == "" {
		body.Code = "internal"
	}
	srv.endJob(job, s, `state = 'failed', error = ?, error_code = ?`, body.Error, body.Code)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// endJob records the end, signs the job's session out and lets the Chromium go.
func (srv *Server) endJob(job *jobRow, s *Session, set string, args ...any) {
	now := ts(srv.now())
	values := append(args, now, now, job.ID)
	if _, err := srv.db.Exec(`UPDATE jobs SET `+set+`, finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'`, values...); err != nil {
		log.Printf("jobs: end %s: %v", job.ID, err)
	}
	_, _ = srv.db.Exec(`UPDATE devices SET signed_out_at = ? WHERE id = ?`, now, s.DeviceID)
	srv.accountChanged(s.User.ID)
	srv.jobs.mu.Lock()
	delete(srv.jobs.paces, job.ID)
	srv.jobs.mu.Unlock()
	srv.notifyJob(s.User.ID, job.ID)
	srv.cancelRun(job.ID)
	srv.wakeJobs()
}

// checkStalls marks the running jobs that did not move for more than twice the normal time of a step (FR-063), and drops old ones. A job
// whose page never entered (its ticket expired) or entered and never said anything is not working: it fails with the reason and leaves
// its place, instead of holding a generator and the other jobs of its note for the 3 hours of jobMaxRun (24/11).
func (srv *Server) checkStalls() {
	now := srv.now()
	srv.failStuck(`state = 'running' AND device_id IS NULL AND started_at < ?`, ts(now.Add(-jobTicketTTL)), jobNeverOpened)
	srv.failStuck(`state = 'running' AND device_id IS NOT NULL AND last_progress_at IS NULL AND started_at < ?`, ts(now.Add(-jobSilentStart)), jobNeverSaidStart)
	limit := ts(now.Add(-2 * jobNormalStep))
	rows, err := srv.db.Query(`SELECT id, user_id, COALESCE(last_progress_at, started_at) FROM jobs WHERE state = 'running' AND stalled_since IS NULL AND COALESCE(last_progress_at, started_at) < ?`, limit)
	if err != nil {
		return
	}
	type stalled struct{ id, user, since string }
	var found []stalled
	for rows.Next() {
		var item stalled
		if rows.Scan(&item.id, &item.user, &item.since) == nil {
			found = append(found, item)
		}
	}
	rows.Close()
	for _, item := range found {
		if _, err := srv.db.Exec(`UPDATE jobs SET stalled_since = ?, updated_at = ? WHERE id = ?`, item.since, ts(now), item.id); err == nil {
			srv.notifyJob(item.user, item.id)
		}
	}
	_, _ = srv.db.Exec(`DELETE FROM jobs WHERE state NOT IN ('queued', 'running') AND finished_at < ?`, ts(now.Add(-jobsKeptDays*24*time.Hour)))
}

// failStuck fails the running jobs that match, with the reason, and stops their Chromium.
func (srv *Server) failStuck(where, before, message string) {
	rows, err := srv.db.Query(`SELECT id, user_id FROM jobs WHERE `+where, before)
	if err != nil {
		return
	}
	type stuck struct{ id, user string }
	var found []stuck
	for rows.Next() {
		var item stuck
		if rows.Scan(&item.id, &item.user) == nil {
			found = append(found, item)
		}
	}
	rows.Close()
	now := ts(srv.now())
	for _, item := range found {
		res, err := srv.db.Exec(`UPDATE jobs SET state = 'failed', error = ?, error_code = 'internal', finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'`, message, now, now, item.id)
		if err != nil {
			continue
		}
		if changed, _ := res.RowsAffected(); changed == 0 {
			continue
		}
		srv.logf("jobs: %s %s", item.id, message)
		srv.notifyJob(item.user, item.id)
		srv.cancelRun(item.id)
	}
	if len(found) > 0 {
		srv.wakeJobs()
	}
}

// failJobsOf stops every job of an account (access taken away), with the reason.
func (srv *Server) failJobsOf(userID, code, message string) {
	rows, err := srv.db.Query(`SELECT id FROM jobs WHERE user_id = ? AND state IN ('queued', 'running')`, userID)
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	now := ts(srv.now())
	for _, id := range ids {
		if _, err := srv.db.Exec(`UPDATE jobs SET state = 'failed', error = ?, error_code = ?, finished_at = ?, updated_at = ? WHERE id = ?`, message, code, now, now, id); err == nil {
			srv.cancelRun(id)
			srv.notifyJob(userID, id)
		}
	}
}
