---
name: Microsoft Teams provider
description: How Quorum detects, captures and (eventually) posts its notice in Microsoft Teams calls on macOS
status: active
type: plan
started: 2026-11-08
---

# Microsoft Teams provider

Teams runs two ways on a Mac: the desktop app (new Teams, bundle id `com.microsoft.teams2`, a WebView2 shell around the web client; classic Teams was `com.microsoft.teams`, an Electron app) and the web client in a browser tab (`teams.microsoft.com`, same browsers as Meet). Both render the same web UI, so one AX strategy serves both.

## Detection

**Desktop app.** The main window exists all day, so its presence says nothing about a call. In a meeting Teams opens a second window; its title has been seen as the meeting name followed by ` | Microsoft Teams`. `TeamsProvider` in `helper/Sources/QuorumHelper/MeetingProviders.swift` looks through every window of apps with the `com.microsoft.teams` prefix for a button labeled "Leave" (Teams labels it "Leave" with the shortcut in the description) or "Hang up", and only then reports a call. The title with the Teams suffix removed becomes the meeting title.

**Browser.** Tab titles contain `Microsoft Teams`; the pre-join screen and the call share the title, so the same Leave button check applies.

**Getting the web tree.** The WebView2 shell is Chromium, so the helper sets `AXManualAccessibility` on the Teams application element, as it does for browsers. Whether new Teams honors it, or needs `AXEnhancedUserInterface`, is unverified.

**Verified on 2026-11-08:** nothing against Teams itself. Teams is not installed on this Mac and no call was available. The bundle id `com.microsoft.teams2` is confirmed from Microsoft's own PPPC guidance. The Leave button label, the window title format and the participant count element are from Teams' current UI as remembered and need `QuorumHelper dump-ax com.microsoft.teams` during a real call.

## Audio capture

`PROVIDERS.teams.bundles` in `app/main.js` passes `com.microsoft.teams` (covers `teams2` and its WebView helper processes) plus the browser prefixes listed in [[google-meet]], so a call in either form is heard. In the desktop case the tap narrows to Teams alone; in the browser case it hears the whole browser.

## What AX exposes

| Field | Where | Status |
|---|---|---|
| Meeting title | window title minus the `Microsoft Teams` suffix | implemented, unverified |
| Participant count | number on the "People" / "Participants" button | best effort via `Providers.countNear`, unverified |
| Participant names | the People pane, only when open | not read; P1 follow-up |
| In-meeting chat | the Chat pane: message list and "Type a message" box | not read; P2 |

Teams also exposes a roster to Graph APIs, but Quorum reads only what is on this Mac, so that stays out of scope.

## STOP/GO notice

Posting in the Teams meeting chat means opening the Chat pane (button "Chat"), setting the compose box (`AXTextArea`, contenteditable) and pressing Return. Teams' compose box is rich text and may reject `AXValue` writes, in which case the fallback is typing through `CGEvent` key events. Untested, so `TeamsProvider.canPostNotice` is `false` and the same fallback as Meet applies: capture starts when you confirm, the on-screen card is the notice, the log says no in-call notice went out, and the saved note records `platform: Microsoft Teams` and `notice: not posted (...)`.

## Phases

- **P0 detect + capture (implemented, unverified):** `TeamsProvider` with the Leave button check on desktop and browser windows, `com.microsoft.teams` plus browser prefixes for the tap, `meeting` event carries `app: "Microsoft Teams"` and `provider: "teams"`, Settings row.
- **P1 title + participants:** install Teams, run `dump-ax com.microsoft.teams` in a call, confirm the window title format and the People count, read names from the People pane.
- **P2 chat notice:** open the Chat pane, post the notice, confirm it in the message list, read STOP/GO; then flip `canPostNotice`.

## Related

- [[quorum]]
- [[google-meet]]
