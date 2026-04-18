Read the entire repository and understand the current architecture and implementation.

This project is implementing an AI + heuristic risk scoring system for tool calls.

Previously completed:
- Added @anthropic-ai/sdk
- Created ai-classifier.ts

Currently in progress:
- Refactoring risk.ts to support fusion scoring (heuristic + AI classifier)

Next tasks:
- Refactor risk.ts for fusion
- Update config.ts for AI block
- Wire the scoring system into mcp-entry.ts and proxy.ts
- Surface AI reasoning in notifications
- Update the score CLI command
- Build, typecheck, test, and docs
- Add/update tests

First analyze the repository and explain:
1. What the current architecture looks like
2. What each relevant file does
3. What changes are still required

Then continue implementing the remaining tasks starting from:
"Refactor risk.ts for fusion".