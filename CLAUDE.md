# Claude Code Project Rules

## Primary goal
Deliver correct, maintainable changes while minimizing unnecessary context, tool calls, and usage. Efficiency never overrides correctness, security, or the user's explicit instructions.

## Scope and discovery
- Start from the user's stated goal and identify the smallest relevant part of the codebase.
- Prefer targeted filename and symbol searches; do not read the whole repository by default.
- Read only relevant sections of files when possible. Avoid reopening unchanged content without a reason.
- Reuse known project conventions and existing utilities before introducing new approaches.
- Do not recursively inspect generated outputs, build folders, dependency trees, logs, or large data files unless explicitly needed.
- If requirements are ambiguous and a wrong choice would be costly, ask one focused question. Otherwise make a reasonable assumption and state it briefly.

## Implementation
- Make the smallest complete change that satisfies the request.
- Preserve existing behavior, architecture, naming, and formatting unless the task requires changing them.
- Avoid unrelated refactors, sweeping formatting changes, new dependencies, and speculative features.
- Do not silently change security-sensitive behavior or delete user data.
- For complex tasks, outline a brief plan; for simple tasks, implement directly.
- Avoid repeatedly asking for permission for ordinary, reversible steps; respect tool permissions and ask before destructive or high-impact actions.

## Testing and tool output
- Run the narrowest relevant test or check first; expand coverage if failures or change risk warrant it.
- Do not skip necessary tests, type checks, security checks, or other validation solely to save tokens.
- Keep command output concise where practical; retain enough information to diagnose failures.
- If a test fails, focus on the relevant error and affected files, not entire logs.
- Avoid repeatedly running identical commands without a reason.
- Run full suites when requested, when warranted by broad changes, or before release if project requirements demand it.

## Context and agents
- Treat context as a limited resource: avoid dumping complete files, large diffs, or lengthy command outputs into the conversation.
- Prefer one focused workflow over multiple parallel agents. Use a subagent only when it has a clear advantage; agents also consume usage.
- Do not continue an unrelated task just because it appeared in earlier conversation history.
- After long or multi-stage work, write a concise handoff summary in the response so it can be reused in a fresh session.
- If context becomes crowded, summarize what has been done and what remains; do not assume this file can clear conversation history or reset quotas.

## Response style
- Reply in Turkish unless the user requests another language.
- Be concise and action-oriented, without repetitive progress narration.
- On completion, report: changes made, verification results, and any unresolved blocker or next step.
- Mention only meaningful risks or decisions; do not claim tests passed unless they actually ran.

## Priority
Follow the user's latest explicit request and higher-priority instructions if they conflict with these defaults.
