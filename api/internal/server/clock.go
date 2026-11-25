package server

import (
	"log"
	"strings"
	"time"
)

// ClockFromEnv is the service's clock (spec 007, T006). With ESTUDO_DEV=1, ESTUDO_AGORA ("+25h", "-2h") moves it, so a link of
// 1 day can expire in a local test; anywhere else, and with a value that is not a duration, it is the real clock.
func ClockFromEnv(dev, offset string) func() time.Time {
	offset = strings.TrimSpace(offset)
	if dev != "1" || offset == "" {
		return time.Now
	}
	shift, err := time.ParseDuration(offset)
	if err != nil {
		log.Printf("ESTUDO_AGORA=%q is not a duration (+25h, -2h): the clock is the real one", offset)
		return time.Now
	}
	log.Printf("ESTUDO_AGORA: the clock runs %s from the real one (dev only)", shift)
	return func() time.Time { return time.Now().Add(shift) }
}
