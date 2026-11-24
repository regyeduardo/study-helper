package langs

import (
	"database/sql"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

// Spec 004, 24/11 (FR-025, FR-028 a FR-031, FR-039; data-model.md › Mudança de 24/11): "É por card". Each card has its FSRS
// schedule, computed by the app (src/lib/langs/fsrs.ts, the same in the three places) and kept here; an item's state in each
// skill comes from the cards that train it.

// Schedule is a card's FSRS state, as the app sends it after an answer.
type Schedule struct {
	State         string  `json:"state"`
	Step          int     `json:"step"`
	Stability     float64 `json:"stability"`
	Difficulty    float64 `json:"difficulty"`
	DueAt         *string `json:"dueAt"`
	LastReviewAt  *string `json:"lastReviewAt"`
	ScheduledDays int     `json:"scheduledDays"`
	Reps          int     `json:"reps"`
	Lapses        int     `json:"lapses"`
}

// fixedDays is the interval from which a card is fixed (Anki's "mature").
const fixedDays = 21

func stampOf(value *string) (any, error) {
	if value == nil || *value == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		return nil, ErrInvalidAnswer
	}
	return Stamp(parsed), nil
}

func (s Schedule) valid() bool {
	switch s.State {
	case "new", "learning", "review", "relearning":
	default:
		return false
	}
	return s.Step >= 0 && s.Stability >= 0 && s.Difficulty >= 0 && s.ScheduledDays >= 0 && s.Reps >= 0 && s.Lapses >= 0
}

func saveSchedule(tx *sql.Tx, user, code, card string, s Schedule) error {
	if !s.valid() {
		return ErrInvalidAnswer
	}
	due, err := stampOf(s.DueAt)
	if err != nil {
		return err
	}
	last, err := stampOf(s.LastReviewAt)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO lang_card_schedule (user_id, language, card_id, state, step, stability, difficulty, due_at, last_review_at, scheduled_days, reps, lapses)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id, language, card_id) DO UPDATE SET state = excluded.state, step = excluded.step, stability = excluded.stability,
		difficulty = excluded.difficulty, due_at = excluded.due_at, last_review_at = excluded.last_review_at, scheduled_days = excluded.scheduled_days,
		reps = excluded.reps, lapses = excluded.lapses`,
		user, code, card, s.State, s.Step, s.Stability, s.Difficulty, due, last, s.ScheduledDays, s.Reps, s.Lapses)
	return err
}

// Schedules are the schedules of the given cards of the language (a card never answered has none: it is new).
func Schedules(db *sql.DB, user, code string, cards []string) (map[string]Schedule, error) {
	out := map[string]Schedule{}
	for start := 0; start < len(cards); start += 400 {
		end := min(start+400, len(cards))
		args := []any{user, code}
		marks := make([]string, 0, end-start)
		for _, id := range cards[start:end] {
			args = append(args, id)
			marks = append(marks, "?")
		}
		rows, err := db.Query(`SELECT card_id, state, step, COALESCE(stability, 0), COALESCE(difficulty, 0), due_at, last_review_at, scheduled_days, reps, lapses
			FROM lang_card_schedule WHERE user_id = ? AND language = ? AND card_id IN (`+strings.Join(marks, ",")+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			var s Schedule
			var due, last sql.NullString
			if err := rows.Scan(&id, &s.State, &s.Step, &s.Stability, &s.Difficulty, &due, &last, &s.ScheduledDays, &s.Reps, &s.Lapses); err != nil {
				rows.Close()
				return nil, err
			}
			if due.Valid {
				s.DueAt = &due.String
			}
			if last.Valid {
				s.LastReviewAt = &last.String
			}
			out[id] = s
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// rating is the FSRS grade of an answer the app corrected: wrong = Again (1), right only after the learn card = Hard (2), right =
// Good (3); a skipped card has none.
func rating(ok *bool, retry bool) any {
	switch {
	case ok == nil:
		return nil
	case !*ok:
		return 1
	case retry:
		return 2
	}
	return 3
}

// reuseKey says when a practice card is the same as one the language already has (FR-039, "mesmo contexto"): the same kind of card,
// on the same items, about the same sentence. Test cards are reused by their id (item__n, the same in every text); context cards,
// about the text itself, are never reused.
func reuseKey(card Card) string {
	context := ""
	for _, value := range []string{strings.Join(card.SayList(), " / "), card.Text, card.Answer, card.Target, card.Word, card.Q} {
		if value = Clean(value); value != "" {
			context = value
			break
		}
	}
	covers := append([]string{}, card.Covers...)
	sort.Strings(covers)
	return card.Type + "|" + strings.Join(covers, ",") + "|" + context
}

// fillReuseKeys gives a key to the practice cards that came without one (the ones of texts made before 24/11). A card whose key
// another card of the language already has stays without one: it is still studied, it is just not the one that gets reused.
func fillReuseKeys(tx *sql.Tx, user, code string) error {
	rows, err := tx.Query(`SELECT DISTINCT c.id, c.data FROM lang_cards c JOIN lang_text_cards tc ON tc.user_id = c.user_id AND tc.language = c.language AND tc.card_id = c.id
		WHERE c.user_id = ? AND c.language = ? AND c.reuse_key IS NULL AND tc.part = 'practice' ORDER BY c.created_at, c.id`, user, code)
	if err != nil {
		return err
	}
	type pending struct{ id, key string }
	list := []pending{}
	for rows.Next() {
		var id, data string
		var card Card
		if err := rows.Scan(&id, &data); err != nil {
			rows.Close()
			return err
		}
		if json.Unmarshal([]byte(data), &card) == nil {
			list = append(list, pending{id, reuseKey(card)})
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, p := range list {
		var taken int
		if tx.QueryRow(`SELECT 1 FROM lang_cards WHERE user_id = ? AND language = ? AND reuse_key = ?`, user, code, p.key).Scan(&taken) == nil {
			continue
		}
		if _, err := tx.Exec(`UPDATE lang_cards SET reuse_key = ? WHERE user_id = ? AND language = ? AND id = ?`, p.key, user, code, p.id); err != nil {
			return err
		}
	}
	return nil
}

// skillOf is the skill of the base a card trains: ordering produces, listening listens, speaking speaks, the rest recognizes.
func skillOf(cardType, skill string) string {
	switch {
	case skill == "listen" || skill == "speak":
		return skill
	case cardType == "order":
		return "produce"
	}
	return "recognize"
}

type skillState struct {
	cards, fixed int
	due          bool
}

// itemStates is, for each item the person has answered, each skill: how many of its cards were answered, how many are fixed and
// whether one is due (or still in the short steps).
func itemStates(db *sql.DB, user, code string, now time.Time) (map[string]map[string]*skillState, error) {
	rows, err := db.Query(`SELECT ci.item_id, c.type, c.skill, s.state, s.scheduled_days, COALESCE(s.due_at, '')
		FROM lang_card_schedule s
		JOIN lang_cards c ON c.user_id = s.user_id AND c.language = s.language AND c.id = s.card_id
		JOIN lang_card_items ci ON ci.user_id = s.user_id AND ci.language = s.language AND ci.card_id = s.card_id AND ci.role = 'covers'
		WHERE s.user_id = ? AND s.language = ? AND s.state != 'new'`, user, strings.ToLower(code))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]*skillState{}
	at := Stamp(now)
	for rows.Next() {
		var item, cardType, skill, state, due string
		var days int
		if err := rows.Scan(&item, &cardType, &skill, &state, &days, &due); err != nil {
			return nil, err
		}
		if out[item] == nil {
			out[item] = map[string]*skillState{}
		}
		k := skillOf(cardType, skill)
		if out[item][k] == nil {
			out[item][k] = &skillState{}
		}
		s := out[item][k]
		s.cards++
		if state == "review" && days >= fixedDays {
			s.fixed++
		}
		// a card in the short steps (learning again after a mistake) is due too: the item is not proven
		if state != "review" || (due != "" && due <= at) {
			s.due = true
		}
	}
	return out, rows.Err()
}

func fixedItem(skills map[string]*skillState) bool {
	for _, s := range skills {
		if s.fixed < s.cards {
			return false
		}
	}
	return len(skills) > 0
}

func dueItem(skills map[string]*skillState) bool {
	for _, s := range skills {
		if s.due {
			return true
		}
	}
	return false
}

// Knowledge is the base of the language by item: each skill seen ("learning", or "fixed" when all its cards are), whether a review
// is due, and "hearsAndSpeaks" when the item passed 2 different listening cards and 2 speaking ones on different days (FR-031).
func Knowledge(db *sql.DB, user, code string, now time.Time) (map[string]map[string]any, error) {
	code = strings.ToLower(code)
	states, err := itemStates(db, user, code, now)
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]any{}
	for item, skills := range states {
		k := map[string]any{"due": dueItem(skills)}
		for skill, s := range skills {
			k[skill] = "learning"
			if s.fixed == s.cards {
				k[skill] = "fixed"
			}
		}
		out[item] = k
	}
	both, err := hearsAndSpeaks(db, user, code)
	if err != nil {
		return nil, err
	}
	for item := range both {
		if out[item] != nil {
			out[item]["hearsAndSpeaks"] = true
		}
	}
	return out, nil
}

// hearsAndSpeaks are the items right in at least 2 different listening cards and 2 different speaking cards, each skill on at least
// 2 different days (each card is a situation; owner, 24/11).
func hearsAndSpeaks(db *sql.DB, user, code string) (map[string]bool, error) {
	rows, err := db.Query(`SELECT ci.item_id, c.skill, COUNT(DISTINCT a.card_id), COUNT(DISTINCT substr(a.created_at, 1, 10))
		FROM lang_answers a
		JOIN lang_cards c ON c.user_id = a.user_id AND c.language = a.language AND c.id = a.card_id
		JOIN lang_card_items ci ON ci.user_id = a.user_id AND ci.language = a.language AND ci.card_id = a.card_id AND ci.role = 'covers'
		WHERE a.user_id = ? AND a.language = ? AND a.ok = 1 AND c.skill IN ('listen', 'speak')
		GROUP BY ci.item_id, c.skill`, user, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	passed := map[string]int{}
	for rows.Next() {
		var item, skill string
		var cards, days int
		if err := rows.Scan(&item, &skill, &cards, &days); err != nil {
			return nil, err
		}
		if cards >= 2 && days >= 2 {
			passed[item]++
		}
	}
	out := map[string]bool{}
	for item, n := range passed {
		if n == 2 {
			out[item] = true
		}
	}
	return out, rows.Err()
}
