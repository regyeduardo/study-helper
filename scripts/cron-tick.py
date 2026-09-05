#!/usr/bin/env python3
"""Force-run the study-helper cron job."""
import sys, os, json
sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))

from cron.scheduler import tick

os.chdir("/home/edu/workspace/personal/study-helper")
count = tick(verbose=True)
sys.exit(0 if count > 0 else 0)  # success even if no jobs due
