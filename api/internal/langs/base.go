package langs

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

func newTextID() string {
	buffer := make([]byte, 12)
	_, _ = rand.Read(buffer)
	return base64.RawURLEncoding.EncodeToString(buffer)
}

// TextOut gives a ready text whole; a text not ready gives ErrNotReady and its status.
func TextOut(db *sql.DB, user, code, id string) (Text, Status, error) {
	t, err := textOf(db, user, code, id)
	if err != nil {
		return Text{}, Status{}, err
	}
	if t.status != "ready" {
		return Text{}, Status{Status: t.status, Error: t.error}, ErrNotReady
	}
	l, err := language(db, user, t.language)
	if err != nil {
		return Text{}, Status{}, err
	}
	out := Text{ID: id, Language: l.Code, Locale: l.Locale, Title: t.title, Status: t.status, Facets: Facets}
	out.Lines = Lines(t.body)
	if out.Equivalences, err = Equivalences(db, user, l.Code); err != nil {
		return out, Status{}, err
	}
	if out.Items, err = textItems(db, user, l.Code, id); err != nil {
		return out, Status{}, err
	}
	out.Practice, out.Context = []Card{}, []Card{}
	rows, err := db.Query(`SELECT tc.part, COALESCE(c.item_id, ''), c.data FROM lang_text_cards tc
		JOIN lang_cards c ON c.user_id = tc.user_id AND c.language = tc.language AND c.id = tc.card_id
		WHERE tc.user_id = ? AND tc.text_id = ? ORDER BY tc.position`, user, id)
	if err != nil {
		return out, Status{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var part, item, data string
		if err := rows.Scan(&part, &item, &data); err != nil {
			return out, Status{}, err
		}
		var card Card
		if err := json.Unmarshal([]byte(data), &card); err != nil {
			return out, Status{}, err
		}
		switch part {
		case "test":
			if it, ok := out.Items.ByID[item]; ok {
				it.Test = append(it.Test, card)
				out.Items.ByID[item] = it
			}
		case "practice":
			out.Practice = append(out.Practice, card)
		case "context":
			out.Context = append(out.Context, card)
		}
	}
	if err := rows.Err(); err != nil {
		return out, Status{}, err
	}
	if out.Needed, err = neededItems(db, user, l.Code, out.Items); err != nil {
		return out, Status{}, err
	}
	ids := []string{}
	for _, list := range []Items{out.Items, out.Needed} {
		for _, it := range list.ByID {
			for _, card := range it.Test {
				ids = append(ids, card.ID)
			}
		}
	}
	for _, card := range append(append([]Card{}, out.Practice...), out.Context...) {
		ids = append(ids, card.ID)
	}
	if out.Schedules, err = Schedules(db, user, l.Code, ids); err != nil {
		return out, Status{}, err
	}
	return out, Status{Status: "ready"}, nil
}

// neededItems is what the text's items need, to the end, and the text does not have: items of the base from other texts, each with
// what it needs and its test cards (the ones of any text, without repeating a card).
func neededItems(db *sql.DB, user, code string, items Items) (Items, error) {
	needed := Items{ByID: map[string]Item{}}
	needs, err := needsOf(db, user, code)
	if err != nil {
		return needed, err
	}
	queue := []string{}
	for _, id := range items.Keys {
		queue = append(queue, needs[id]...)
	}
	seen := map[string]bool{}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if _, own := items.ByID[id]; own || seen[id] {
			continue
		}
		seen[id] = true
		rows, err := db.Query(`SELECT `+itemColumns+` FROM lang_items i WHERE i.user_id = ? AND i.language = ? AND i.id = ?`, user, code, id)
		if err != nil {
			return needed, err
		}
		var item Item
		found := false
		if rows.Next() {
			if _, item, err = scanItem(rows); err != nil {
				rows.Close()
				return needed, err
			}
			found = true
		}
		rows.Close()
		if !found {
			continue
		}
		if list := needs[id]; list != nil {
			item.Needs = list
		}
		cards, err := db.Query(`SELECT data FROM lang_cards WHERE user_id = ? AND language = ? AND item_id = ? ORDER BY id`, user, code, id)
		if err != nil {
			return needed, err
		}
		have := map[string]bool{}
		for cards.Next() {
			var data string
			var card Card
			if err := cards.Scan(&data); err != nil {
				cards.Close()
				return needed, err
			}
			if json.Unmarshal([]byte(data), &card) == nil && !have[card.ID] {
				have[card.ID] = true
				item.Test = append(item.Test, card)
			}
		}
		cards.Close()
		needed.Add(id, item)
		queue = append(queue, needs[id]...)
	}
	return needed, nil
}

type storedItem struct {
	Say    string            `json:"say,omitempty"`
	Expl   string            `json:"expl,omitempty"`
	Ex     []string          `json:"ex,omitempty"`
	Facets map[string]string `json:"facets,omitempty"`
}

func scanItem(rows *sql.Rows) (string, Item, error) {
	var id, data string
	var word, pattern, core sql.NullString
	var it Item
	if err := rows.Scan(&id, &it.Area, &it.Kind, &it.Label, &it.Meaning, &word, &pattern, &core, &data); err != nil {
		return "", it, err
	}
	it.Word, it.Pattern, it.Core = word.String, pattern.String, core.String
	var extra storedItem
	_ = json.Unmarshal([]byte(data), &extra)
	it.Say, it.Expl, it.Ex, it.Facets = extra.Say, extra.Expl, extra.Ex, extra.Facets
	if it.Ex == nil {
		it.Ex = []string{}
	}
	if it.Facets == nil {
		it.Facets = map[string]string{}
	}
	it.Needs, it.Test = []string{}, []Card{}
	return id, it, nil
}

const itemColumns = `i.id, i.area, i.kind, i.label, i.meaning, i.word, i.pattern, i.core, i.data`

func textItems(db *sql.DB, user, code, textID string) (Items, error) {
	items := Items{ByID: map[string]Item{}}
	rows, err := db.Query(`SELECT `+itemColumns+` FROM lang_text_items ti JOIN lang_items i ON i.user_id = ti.user_id AND i.language = ? AND i.id = ti.item_id
		WHERE ti.user_id = ? AND ti.text_id = ? ORDER BY ti.position`, code, user, textID)
	if err != nil {
		return items, err
	}
	for rows.Next() {
		id, it, err := scanItem(rows)
		if err != nil {
			rows.Close()
			return items, err
		}
		items.Add(id, it)
	}
	rows.Close()
	needs, err := needsOf(db, user, code)
	if err != nil {
		return items, err
	}
	for _, id := range items.Keys {
		it := items.ByID[id]
		if list := needs[id]; list != nil {
			it.Needs = list
		}
		items.ByID[id] = it
	}
	return items, nil
}

func needsOf(db *sql.DB, user, code string) (map[string][]string, error) {
	rows, err := db.Query(`SELECT item_id, needs_id FROM lang_item_needs WHERE user_id = ? AND language = ? ORDER BY rowid`, user, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var item, need string
		if err := rows.Scan(&item, &need); err != nil {
			return nil, err
		}
		out[item] = append(out[item], need)
	}
	return out, rows.Err()
}

// BaseItem is an item the language already has, as the generation sees it to reuse its id.
type BaseItem struct {
	ID    string
	Area  string
	Kind  string
	Label string
	Needs []string
}

// Base is every item of the language (id → its needs) and a short list of them for the generation.
func Base(db *sql.DB, user, code string) (map[string][]string, []BaseItem, error) {
	needs, err := needsOf(db, user, code)
	if err != nil {
		return nil, nil, err
	}
	rows, err := db.Query(`SELECT id, area, kind, label FROM lang_items WHERE user_id = ? AND language = ? ORDER BY created_at, id`, user, code)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	graph := map[string][]string{}
	list := []BaseItem{}
	for rows.Next() {
		var b BaseItem
		if err := rows.Scan(&b.ID, &b.Area, &b.Kind, &b.Label); err != nil {
			return nil, nil, err
		}
		b.Needs = needs[b.ID]
		graph[b.ID] = b.Needs
		list = append(list, b)
	}
	return graph, list, rows.Err()
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// SaveContent keeps what was generated for a text, and the text is ready. Items already in the base keep their id and take the new
// content; the language's equivalences gain the new groups.
func SaveContent(db *sql.DB, user, code, textID string, c Content, model string, now time.Time) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	at := Stamp(now)
	var status string
	if err := tx.QueryRow(`SELECT status FROM lang_texts WHERE user_id = ? AND id = ? AND language = ?`, user, textID, code).Scan(&status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	for _, id := range c.Items.Keys {
		it := c.Items.ByID[id]
		data, _ := json.Marshal(storedItem{Say: it.Say, Expl: it.Expl, Ex: it.Ex, Facets: it.Facets})
		if _, err := tx.Exec(`INSERT INTO lang_items (user_id, language, id, area, kind, label, meaning, word, pattern, core, data, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (user_id, language, id) DO UPDATE SET area = excluded.area, kind = excluded.kind, label = excluded.label, meaning = excluded.meaning,
			word = excluded.word, pattern = excluded.pattern, core = excluded.core, data = excluded.data, updated_at = excluded.updated_at`,
			user, code, id, it.Area, it.Kind, it.Label, it.Meaning, nullable(it.Word), nullable(it.Pattern), nullable(it.Core), string(data), at, at); err != nil {
			return err
		}
	}
	for _, id := range c.Items.Keys {
		if _, err := tx.Exec(`DELETE FROM lang_item_needs WHERE user_id = ? AND language = ? AND item_id = ?`, user, code, id); err != nil {
			return err
		}
		for _, need := range c.Items.ByID[id].Needs {
			if _, err := tx.Exec(`INSERT OR IGNORE INTO lang_item_needs (user_id, language, item_id, needs_id) VALUES (?, ?, ?, ?)`, user, code, id, need); err != nil {
				return err
			}
		}
	}
	if err := mergeEquivalences(tx, user, code, c.Equivalences); err != nil {
		return err
	}
	for _, table := range []string{"lang_text_cards", "lang_text_items"} {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE user_id = ? AND text_id = ?`, user, textID); err != nil {
			return err
		}
	}
	if err := fillReuseKeys(tx, user, code); err != nil {
		return err
	}
	for position, id := range c.Items.Keys {
		if _, err := tx.Exec(`INSERT INTO lang_text_items (user_id, text_id, item_id, position) VALUES (?, ?, ?, ?)`, user, textID, id, position); err != nil {
			return err
		}
	}
	position := 0
	// FR-039: a test card of an item is the same card in every text (its id, item__n, comes from the cache of the word) and takes the
	// newest content; a practice card on the same items about the same sentence is the one the language already has, with its
	// schedule; any other card is the text's (its id gets the text's in front, to never meet another text's).
	put := func(part, item string, card Card) error {
		if part == "test" && len(card.Covers) == 0 {
			card.Covers = []string{item}
		}
		key := ""
		switch part {
		case "practice":
			key = reuseKey(card)
			var existing string
			if tx.QueryRow(`SELECT id FROM lang_cards WHERE user_id = ? AND language = ? AND reuse_key = ?`, user, code, key).Scan(&existing) == nil {
				card.ID, key = existing, ""
			} else {
				card.ID = textID + "." + card.ID
			}
		case "context":
			card.ID = textID + "." + card.ID
		}
		data, err := json.Marshal(card)
		if err != nil {
			return err
		}
		if key != "" || part != "practice" {
			if _, err := tx.Exec(`INSERT INTO lang_cards (user_id, language, id, item_id, type, skill, reuse_key, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (user_id, language, id) DO UPDATE SET item_id = excluded.item_id, type = excluded.type, skill = excluded.skill, data = excluded.data`,
				user, code, card.ID, nullable(item), card.Type, card.Skill, nullable(key), string(data), at); err != nil {
				return err
			}
			for role, list := range map[string][]string{"covers": card.Covers, "needs": card.Needs} {
				for _, it := range list {
					if _, err := tx.Exec(`INSERT OR IGNORE INTO lang_card_items (user_id, language, card_id, item_id, role) VALUES (?, ?, ?, ?, ?)`, user, code, card.ID, it, role); err != nil {
						return err
					}
				}
			}
		}
		result, err := tx.Exec(`INSERT OR IGNORE INTO lang_text_cards (user_id, text_id, language, card_id, part, position) VALUES (?, ?, ?, ?, ?, ?)`,
			user, textID, code, card.ID, part, position)
		if err != nil {
			return err
		}
		if n, _ := result.RowsAffected(); n > 0 {
			position++
		}
		return nil
	}
	for _, id := range c.Items.Keys {
		for _, card := range c.Items.ByID[id].Test {
			if err := put("test", id, card); err != nil {
				return err
			}
		}
	}
	for _, card := range c.Practice {
		if err := put("practice", "", card); err != nil {
			return err
		}
	}
	for _, card := range c.Context {
		if err := put("context", "", card); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE lang_texts SET status = 'ready', error = NULL, model = ?, ready_at = ? WHERE user_id = ? AND id = ?`, nullable(model), at, user, textID); err != nil {
		return err
	}
	return tx.Commit()
}

func mergeEquivalences(tx *sql.Tx, user, code string, groups [][]string) error {
	for _, group := range groups {
		forms := []string{}
		for _, form := range group {
			if form = strings.ToLower(strings.TrimSpace(form)); form != "" {
				forms = append(forms, form)
			}
		}
		if len(forms) < 2 {
			continue
		}
		number := -1
		for _, form := range forms {
			var existing int
			if tx.QueryRow(`SELECT grp FROM lang_equivalences WHERE user_id = ? AND language = ? AND form = ?`, user, code, form).Scan(&existing) == nil {
				number = existing
				break
			}
		}
		if number < 0 {
			if err := tx.QueryRow(`SELECT COALESCE(MAX(grp), -1) + 1 FROM lang_equivalences WHERE user_id = ? AND language = ?`, user, code).Scan(&number); err != nil {
				return err
			}
		}
		for _, form := range forms {
			if _, err := tx.Exec(`INSERT OR IGNORE INTO lang_equivalences (user_id, language, grp, form) VALUES (?, ?, ?, ?)`, user, code, number, form); err != nil {
				return err
			}
		}
	}
	return nil
}

// FailText marks a text that could not be generated, with the reason (a code, not a sentence).
func FailText(db *sql.DB, user, textID, reason string) error {
	_, err := db.Exec(`UPDATE lang_texts SET status = 'failed', error = ? WHERE user_id = ? AND id = ?`, reason, user, textID)
	return err
}

// Retry puts a failed text back to be generated.
func Retry(db *sql.DB, user, code, textID string) error {
	t, err := textOf(db, user, code, textID)
	if err != nil {
		return err
	}
	if t.status != "failed" {
		return ErrNotFailed
	}
	_, err = db.Exec(`UPDATE lang_texts SET status = 'generating', error = NULL WHERE user_id = ? AND id = ?`, user, textID)
	return err
}

// DeleteText takes the text away; its items stay in the base.
func DeleteText(db *sql.DB, user, code, textID string) error {
	result, err := db.Exec(`DELETE FROM lang_texts WHERE user_id = ? AND id = ? AND language = ?`, user, textID, strings.ToLower(code))
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	_, err = db.Exec(`DELETE FROM lang_progress WHERE user_id = ? AND text_id = ?`, user, textID)
	return err
}

// PendingTexts are the texts left generating (the server stopped in the middle): they go back to the queue when it starts.
func PendingTexts(db *sql.DB) ([][3]string, error) {
	rows, err := db.Query(`SELECT user_id, language, id FROM lang_texts WHERE status = 'generating' ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := [][3]string{}
	for rows.Next() {
		var row [3]string
		if err := rows.Scan(&row[0], &row[1], &row[2]); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Body is the whole text the person sent and its language's name, for the generation.
func Body(db *sql.DB, user, textID string) (code, name, body string, err error) {
	err = db.QueryRow(`SELECT t.language, l.name, t.body FROM lang_texts t JOIN lang_languages l ON l.user_id = t.user_id AND l.code = t.language
		WHERE t.user_id = ? AND t.id = ?`, user, textID).Scan(&code, &name, &body)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// Answer is one answer to a card. OK nil is a skipped card: recorded, never counted.
type Answer struct {
	TextID     string `json:"textId"`
	CardID     string `json:"cardId"`
	Stage      string `json:"stage"`
	PromptLang string `json:"promptLang"`
	Answer     string `json:"answer"`
	OK         *bool  `json:"ok"`
	Retry      bool   `json:"retry"`
	// Schedule is the card's FSRS state after this answer, computed by the app (none when skipped).
	Schedule *Schedule `json:"schedule"`
}

// RecordAnswer keeps the answer, with its FSRS rating, and the card's schedule the app computed (FR-025, FR-029).
func RecordAnswer(db *sql.DB, user, code string, a Answer, now time.Time) error {
	if (a.Stage != "test" && a.Stage != "practice" && a.Stage != "context") || (a.PromptLang != "native" && a.PromptLang != "target") {
		return ErrInvalidAnswer
	}
	code = strings.ToLower(code)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var found int
	err = tx.QueryRow(`SELECT 1 FROM lang_texts t JOIN lang_cards c ON c.user_id = t.user_id AND c.language = t.language AND c.id = ?
		WHERE t.user_id = ? AND t.id = ? AND t.language = ?`, a.CardID, user, a.TextID, code).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var ok any
	if a.OK != nil {
		ok = 0
		if *a.OK {
			ok = 1
		}
	}
	retry := 0
	if a.Retry {
		retry = 1
	}
	if _, err := tx.Exec(`INSERT INTO lang_answers (user_id, language, text_id, card_id, stage, prompt_lang, answer, ok, retry, rating, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		user, code, a.TextID, a.CardID, a.Stage, a.PromptLang, nullable(a.Answer), ok, retry, rating(a.OK, a.Retry), Stamp(now)); err != nil {
		return err
	}
	if a.OK != nil && a.Schedule != nil {
		if err := saveSchedule(tx, user, code, a.CardID, *a.Schedule); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Progress is where the person stopped in a text.
func Progress(db *sql.DB, user, code, textID string) (json.RawMessage, string, error) {
	if _, err := textOf(db, user, code, textID); err != nil {
		return nil, "", err
	}
	var state, updated string
	err := db.QueryRow(`SELECT state, updated_at FROM lang_progress WHERE user_id = ? AND text_id = ?`, user, textID).Scan(&state, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	return json.RawMessage(state), updated, err
}

// SaveProgress keeps where the person is (a JSON object of the study's queue).
func SaveProgress(db *sql.DB, user, code, textID string, state json.RawMessage, now time.Time) error {
	var object map[string]any
	if len(state) > 256<<10 || json.Unmarshal(state, &object) != nil || object == nil {
		return ErrInvalidAnswer
	}
	if _, err := textOf(db, user, code, textID); err != nil {
		return err
	}
	_, err := db.Exec(`INSERT INTO lang_progress (user_id, text_id, state, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id, text_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`, user, textID, string(state), Stamp(now))
	return err
}
