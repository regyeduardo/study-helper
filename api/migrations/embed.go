// Package migrations holds the SQL files that build the database, in order, embedded in the binary.
package migrations

import "embed"

//go:embed *.sql
var Files embed.FS
