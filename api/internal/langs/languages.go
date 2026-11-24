package langs

import (
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// T015 (domain): the languages of an account, the texts it sent, what was generated from them (the base) and its answers.
// Every function works on one account only; another account's row is a row that does not exist.

var (
	ErrLanguageExists  = errors.New("language_exists")
	ErrInvalidLanguage = errors.New("invalid_language")
	ErrNotFound        = errors.New("not_found")
	ErrTitleRequired   = errors.New("title_required")
	ErrTextRequired    = errors.New("text_required")
	ErrTextTooLarge    = errors.New("text_too_large")
	ErrNotReady        = errors.New("not_ready")
	ErrNotFailed       = errors.New("not_failed")
	ErrInvalidAnswer   = errors.New("invalid_answer")
)

// MaxTextChars is the biggest text one can send (data-model: body ≤ 100.000 characters).
const MaxTextChars = 100_000

const maxTitle = 200

// Stamp is the time as the languages tables keep it: fixed width, so text order is time order (due_at <= now).
func Stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// Known are the languages that come with their name and voice; any other is made with a name and the code the person gives.
var Known = map[string]Language{
	"en": {"en", "Inglês", "en-US"}, "es": {"es", "Espanhol", "es-ES"}, "fr": {"fr", "Francês", "fr-FR"}, "de": {"de", "Alemão", "de-DE"},
	"it": {"it", "Italiano", "it-IT"}, "ja": {"ja", "Japonês", "ja-JP"}, "zh": {"zh", "Chinês", "zh-CN"}, "ko": {"ko", "Coreano", "ko-KR"},
	"ru": {"ru", "Russo", "ru-RU"}, "nl": {"nl", "Holandês", "nl-NL"}, "sv": {"sv", "Sueco", "sv-SE"},
}

var (
	codeShape   = regexp.MustCompile(`^[a-z]{2,3}(-[a-z0-9]{2,8})*$`)
	localeShape = regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)
)

type Language struct {
	Code   string `json:"code"`
	Name   string `json:"name"`
	Locale string `json:"locale"`
}

// Counts are the base of a language: items, the ones seen, fixed (every skill seen fixed) and due for review.
type Counts struct {
	Items int `json:"items"`
	Seen  int `json:"seen"`
	Fixed int `json:"fixed"`
	Due   int `json:"due"`
}

type Summary struct {
	Language
	Counts
	Texts int `json:"texts"`
}

type AreaCount struct {
	Total int `json:"total"`
	Seen  int `json:"seen"`
	Fixed int `json:"fixed"`
}

type TextRow struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
	Progress string `json:"progress"`
	// Known is how much of the text the person already knows (FR-038): the percent of its items whose last answers were right
	Known     int    `json:"known"`
	CreatedAt string `json:"createdAt"`
	// Generation is how far the generation is, while it runs (the server's generator fills it)
	Generation *GenProgress `json:"generation,omitempty"`
}

type Detail struct {
	Language
	Counts
	Areas map[string]AreaCount `json:"areas"`
	Texts []TextRow            `json:"texts"`
}

// AddLanguage makes a language for the account. A known code comes with its name and voice; another needs a name.
func AddLanguage(db *sql.DB, user, code, name, locale string, now time.Time) (Language, error) {
	code = strings.ToLower(strings.TrimSpace(code))
	name, locale = strings.TrimSpace(name), strings.TrimSpace(locale)
	if len(code) > 12 || !codeShape.MatchString(code) || utf8.RuneCountInString(name) > 40 || (locale != "" && (len(locale) > 20 || !localeShape.MatchString(locale))) {
		return Language{}, ErrInvalidLanguage
	}
	language, known := Known[code]
	if !known {
		if name == "" {
			return Language{}, ErrInvalidLanguage
		}
		language = Language{Code: code, Name: name, Locale: code}
	}
	if name != "" {
		language.Name = name
	}
	if locale != "" {
		language.Locale = locale
	}
	result, err := db.Exec(`INSERT INTO lang_languages (user_id, code, name, locale, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, user, language.Code, language.Name, language.Locale, Stamp(now))
	if err != nil {
		return Language{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return Language{}, ErrLanguageExists
	}
	return language, nil
}

// counts are the language's items, the ones answered (seen), fixed (every card that trains them fixed) and due, from the cards.
func counts(db *sql.DB, user, code string, now time.Time) (Counts, error) {
	var c Counts
	if err := db.QueryRow(`SELECT COUNT(*) FROM lang_items WHERE user_id = ? AND language = ?`, user, code).Scan(&c.Items); err != nil {
		return c, err
	}
	states, err := itemStates(db, user, code, now)
	if err != nil {
		return c, err
	}
	for _, skills := range states {
		c.Seen++
		if fixedItem(skills) {
			c.Fixed++
		}
		if dueItem(skills) {
			c.Due++
		}
	}
	return c, nil
}

// Languages are the account's languages, in the order they were made, with their counts.
func Languages(db *sql.DB, user string, now time.Time) ([]Summary, error) {
	rows, err := db.Query(`SELECT l.code, l.name, l.locale, (SELECT COUNT(*) FROM lang_texts t WHERE t.user_id = l.user_id AND t.language = l.code)
		FROM lang_languages l WHERE l.user_id = ? ORDER BY l.created_at, l.code`, user)
	if err != nil {
		return nil, err
	}
	out := []Summary{}
	for rows.Next() {
		var s Summary
		if err := rows.Scan(&s.Code, &s.Name, &s.Locale, &s.Texts); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, s)
	}
	rows.Close()
	for n := range out {
		c, err := counts(db, user, out[n].Code, now)
		if err != nil {
			return nil, err
		}
		out[n].Counts = c
	}
	return out, nil
}

func language(db *sql.DB, user, code string) (Language, error) {
	var l Language
	err := db.QueryRow(`SELECT code, name, locale FROM lang_languages WHERE user_id = ? AND code = ?`, user, strings.ToLower(code)).Scan(&l.Code, &l.Name, &l.Locale)
	if errors.Is(err, sql.ErrNoRows) {
		return l, ErrNotFound
	}
	return l, err
}

// progressOf is where the person is in a text: not started, in the middle, or done ({"done": true} in the state).
func progressOf(state sql.NullString) string {
	if !state.Valid {
		return "start"
	}
	var s struct {
		Done bool `json:"done"`
	}
	if json.Unmarshal([]byte(state.String), &s) == nil && s.Done {
		return "done"
	}
	return "continue"
}

// LanguageDetail is one language with its base by area and its texts, the oldest first.
func LanguageDetail(db *sql.DB, user, code string, now time.Time) (Detail, error) {
	l, err := language(db, user, code)
	if err != nil {
		return Detail{}, err
	}
	d := Detail{Language: l, Areas: map[string]AreaCount{}, Texts: []TextRow{}}
	if d.Counts, err = counts(db, user, l.Code, now); err != nil {
		return d, err
	}
	states, err := itemStates(db, user, l.Code, now)
	if err != nil {
		return d, err
	}
	rows, err := db.Query(`SELECT id, area FROM lang_items WHERE user_id = ? AND language = ?`, user, l.Code)
	if err != nil {
		return d, err
	}
	for rows.Next() {
		var id, area string
		if err := rows.Scan(&id, &area); err != nil {
			rows.Close()
			return d, err
		}
		a := d.Areas[area]
		a.Total++
		if skills, seen := states[id]; seen {
			a.Seen++
			if fixedItem(skills) {
				a.Fixed++
			}
		}
		d.Areas[area] = a
	}
	rows.Close()
	rows, err = db.Query(`SELECT t.id, t.title, t.status, COALESCE(t.error, ''), t.created_at, p.state FROM lang_texts t
		LEFT JOIN lang_progress p ON p.user_id = t.user_id AND p.text_id = t.id
		WHERE t.user_id = ? AND t.language = ? ORDER BY t.created_at, t.rowid`, user, l.Code)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	for rows.Next() {
		var t TextRow
		var state sql.NullString
		if err := rows.Scan(&t.ID, &t.Title, &t.Status, &t.Error, &t.CreatedAt, &state); err != nil {
			return d, err
		}
		t.Progress = progressOf(state)
		d.Texts = append(d.Texts, t)
	}
	if err := rows.Err(); err != nil {
		return d, err
	}
	rows.Close()
	known, err := knownByText(db, user, l.Code, states)
	if err != nil {
		return d, err
	}
	for n := range d.Texts {
		d.Texts[n].Known = known[d.Texts[n].ID]
	}
	return d, nil
}

// knownByText is, for each text, the percent of its items proven in the base with no review due (FR-038): answered, every card
// that trains them out of the short steps and none due.
func knownByText(db *sql.DB, user, code string, states map[string]map[string]*skillState) (map[string]int, error) {
	rows, err := db.Query(`SELECT ti.text_id, ti.item_id FROM lang_text_items ti
		JOIN lang_texts t ON t.user_id = ti.user_id AND t.id = ti.text_id AND t.language = ? WHERE ti.user_id = ?`, code, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	total, ok := map[string]int{}, map[string]int{}
	for rows.Next() {
		var text, item string
		if err := rows.Scan(&text, &item); err != nil {
			return nil, err
		}
		total[text]++
		if skills, seen := states[item]; seen && !dueItem(skills) {
			ok[text]++
		}
	}
	out := map[string]int{}
	for text, n := range total {
		out[text] = ok[text] * 100 / n
	}
	return out, rows.Err()
}

// AddText keeps the text whole, waiting to be generated.
func AddText(db *sql.DB, user, code, title, body string, now time.Time) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return "", ErrTitleRequired
	}
	if utf8.RuneCountInString(title) > maxTitle {
		title = string([]rune(title)[:maxTitle])
	}
	if strings.TrimSpace(body) == "" {
		return "", ErrTextRequired
	}
	if utf8.RuneCountInString(body) > MaxTextChars {
		return "", ErrTextTooLarge
	}
	l, err := language(db, user, code)
	if err != nil {
		return "", err
	}
	id := newTextID()
	_, err = db.Exec(`INSERT INTO lang_texts (user_id, id, language, title, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'generating', ?)`, user, id, l.Code, title, body, Stamp(now))
	return id, err
}

// Lines are the text's sentences as the person sent them, without the empty lines.
func Lines(body string) []string {
	out := []string{}
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

// Status is where a text is when it is not ready.
type Status struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// Facet is one aspect of "Tudo sobre" an item.
type Facet struct {
	ID   string `json:"id"`
	Area string `json:"area"`
	Name string `json:"name"`
}

// Facets are the aspects an item may have (the same of the prototype).
var Facets = []Facet{
	{"spoken", "form", "Pronúncia"}, {"written", "form", "Escrita"}, {"parts", "form", "Partes e família"},
	{"meaning", "meaning", "Sentido no trecho"}, {"senses", "meaning", "Outros sentidos"}, {"associations", "meaning", "Parecidas e opostas"},
	{"grammar", "use", "Gramática"}, {"collocations", "use", "Combinações"}, {"use", "use", "Quando usar"},
}

// Text is a ready text as the study reads it.
type Text struct {
	ID       string  `json:"id"`
	Language string  `json:"language"`
	Locale   string  `json:"locale"`
	Title    string  `json:"title"`
	Status   string  `json:"status"`
	Content          // lines, items, practice, context, equivalences
	Facets   []Facet `json:"facets"`
	// Needed: what the text's items need (to the end) that came from other texts, with their test cards; the study tests and teaches
	// them when an item of the text is answered wrong (US3/AC1). Never part of the text's own items.
	Needed Items `json:"needed"`
	// Schedules: the FSRS state of each card of the text (and of the needed items) the person has answered; the others are new.
	Schedules map[string]Schedule `json:"schedules"`
}

type textRow struct {
	language, title, body, status, error string
}

func textOf(db *sql.DB, user, code, id string) (textRow, error) {
	var t textRow
	err := db.QueryRow(`SELECT language, title, body, status, COALESCE(error, '') FROM lang_texts WHERE user_id = ? AND id = ? AND language = ?`, user, id, strings.ToLower(code)).
		Scan(&t.language, &t.title, &t.body, &t.status, &t.error)
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

// Equivalences are the language's groups of forms that say the same.
func Equivalences(db *sql.DB, user, code string) ([][]string, error) {
	rows, err := db.Query(`SELECT grp, form FROM lang_equivalences WHERE user_id = ? AND language = ? ORDER BY grp, rowid`, user, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := [][]string{}
	last := -1
	for rows.Next() {
		var group int
		var form string
		if err := rows.Scan(&group, &form); err != nil {
			return nil, err
		}
		if group != last {
			out = append(out, nil)
			last = group
		}
		out[len(out)-1] = append(out[len(out)-1], form)
	}
	return out, rows.Err()
}
