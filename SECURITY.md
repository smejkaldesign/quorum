# Security

## Reporting a vulnerability

Email security@quorum.watch. Include the version, steps to reproduce, and the impact you see. You will get a response within 5 business days.

Please do not file public issues or pull requests for vulnerabilities. Use email so a fix can ship before the details are public.

## Scope

- The desktop app (`app/`), including the main process, renderer, CLI and MCP server
- The helper (`helper/`): audio capture, transcription, Accessibility access
- The Cloud schema and policies (`supabase/`)

Reports about third-party services the app connects to (Supabase, Claude Code, meeting providers) should go to those vendors.
