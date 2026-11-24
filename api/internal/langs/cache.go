package langs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/regyeduardo/study-helper/api/internal/blobs"
)

// The cache of words (owner, 23/11, "A"): every item generated is kept in R2 for every account (lang/items/<lang>/<id>.json), with
// its test cards written with generic sentences (never someone's text). The same item is never generated again; a report makes it
// again and the new version replaces the old for everyone. lang/items/<lang>/index.json lists what is ready, for the AI.

// Report is a person saying a card is bad.
type Report struct {
	Card   string `json:"card"`
	Reason string `json:"reason"`
	Note   string `json:"note,omitempty"`
	At     string `json:"at"`
}

// CachedItem is one item as kept in R2.
type CachedItem struct {
	ID      string   `json:"id"`
	Item    Item     `json:"item"`
	Model   string   `json:"model"`
	Version int      `json:"version"`
	At      string   `json:"at"`
	Reports []Report `json:"reports,omitempty"`
}

// ReadyItem is one line of the index.
type ReadyItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
	Word  string `json:"word,omitempty"`
}

// ItemCache keeps the items in R2. One server writes the index, one write at a time.
type ItemCache struct {
	Blobs blobs.Store
	mu    sync.Mutex
}

var errNoCache = errors.New("no cache")

func itemKey(code, id string) string { return "lang/items/" + code + "/" + id + ".json" }
func indexKey(code string) string    { return "lang/items/" + code + "/index.json" }

func (c *ItemCache) read(ctx context.Context, key string, into any) error {
	if c == nil || c.Blobs == nil {
		return errNoCache
	}
	reader, _, err := c.Blobs.Get(ctx, key, nil)
	if err != nil {
		return err
	}
	defer reader.Close()
	raw, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}

// Get is a ready item.
func (c *ItemCache) Get(ctx context.Context, code, id string) (CachedItem, error) {
	var item CachedItem
	err := c.read(ctx, itemKey(code, id), &item)
	return item, err
}

// Index is every ready item of the language.
func (c *ItemCache) Index(ctx context.Context, code string) []ReadyItem {
	var index []ReadyItem
	if c.read(ctx, indexKey(code), &index) != nil {
		return nil
	}
	return index
}

// Put keeps an item (a new version replaces the old) and puts it in the index.
func (c *ItemCache) Put(ctx context.Context, code string, item CachedItem) error {
	if c == nil || c.Blobs == nil {
		return errNoCache
	}
	raw, err := json.Marshal(item)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.Blobs.Put(ctx, itemKey(code, item.ID), raw, "application/json", nil); err != nil {
		return err
	}
	index := c.Index(ctx, code)
	line := ReadyItem{ID: item.ID, Label: item.Item.Label, Kind: item.Item.Kind, Word: item.Item.Word}
	found := false
	for n := range index {
		if index[n].ID == item.ID {
			index[n], found = line, true
		}
	}
	if !found {
		index = append(index, line)
	}
	sort.Slice(index, func(a, b int) bool { return index[a].ID < index[b].ID })
	rawIndex, _ := json.Marshal(index)
	return c.Blobs.Put(ctx, indexKey(code), rawIndex, "application/json", nil)
}

// inPiece are the ready items whose words are all in the piece (only those go to the AI).
func inPiece(ready []ReadyItem, piece []string) []ReadyItem {
	words := map[string]bool{}
	for _, word := range tokens(strings.Join(piece, " ")) {
		words[word] = true
	}
	all := func(text string) bool {
		list := tokens(strings.ReplaceAll(text, "_", " "))
		if len(list) == 0 {
			return false
		}
		for _, word := range list {
			if !words[word] {
				return false
			}
		}
		return true
	}
	out := []ReadyItem{}
	for _, item := range ready {
		if all(item.Label) || all(item.ID) || (item.Word != "" && all(item.Word)) {
			out = append(out, item)
		}
	}
	return out
}

func stampNow(now time.Time) string { return Stamp(now) }
