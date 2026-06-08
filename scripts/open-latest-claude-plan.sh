#!/usr/bin/env zsh
set -euo pipefail

plans_dir="${CLAUDE_PLANS_DIR:-$HOME/.claude/plans}"
editor_cmd="${CLAUDE_PLAN_EDITOR:-code}"

if [[ ! -d "$plans_dir" ]]; then
  print -u2 "Claude plans directory does not exist: $plans_dir"
  exit 1
fi

if ! command -v "$editor_cmd" >/dev/null 2>&1; then
  print -u2 "Editor command not found: $editor_cmd"
  print -u2 "Install the command, or set CLAUDE_PLAN_EDITOR to another editor."
  exit 1
fi

latest_plans=("$plans_dir"/*.md(N.om[1]))

if (( ${#latest_plans} == 0 )); then
  print -u2 "No markdown plans found in: $plans_dir"
  exit 1
fi

latest_plan="${latest_plans[1]}"
print "Opening latest Claude plan: $latest_plan"
exec "$editor_cmd" "$latest_plan"
