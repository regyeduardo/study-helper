package server

import (
	"testing"
	"time"
)

// ESTUDO_AGORA moves the service's clock in a dev setup only (spec 007, T006): a link of 1 day expires in a test without waiting.

func TestClockMovesOnlyInDev(t *testing.T) {
	now := ClockFromEnv("1", "+25h")()
	if gap := time.Until(now); gap < 24*time.Hour+59*time.Minute || gap > 25*time.Hour+time.Minute {
		t.Fatalf("dev clock is %v ahead", gap)
	}
	back := ClockFromEnv("1", "-2h")()
	if gap := time.Since(back); gap < 119*time.Minute || gap > 121*time.Minute {
		t.Fatalf("dev clock is %v behind", gap)
	}
	if gap := time.Until(ClockFromEnv("", "+25h")()); gap > time.Minute || gap < -time.Minute {
		t.Fatalf("outside dev the clock moved %v", gap)
	}
	if gap := time.Until(ClockFromEnv("1", "")()); gap > time.Minute || gap < -time.Minute {
		t.Fatalf("without ESTUDO_AGORA the clock moved %v", gap)
	}
}

func TestClockRefusesNonsense(t *testing.T) {
	if gap := time.Until(ClockFromEnv("1", "amanhã")()); gap > time.Minute || gap < -time.Minute {
		t.Fatalf("a value that is not a duration moved the clock %v", gap)
	}
}
