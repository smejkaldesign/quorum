---
name: Google Meet provider
description: How Quorum detects, captures and (eventually) posts its notice in Google Meet calls on macOS
status: active
type: plan
started: 2026-11-08
---

# Google Meet provider

Meet has no desktop app. On a Mac it runs as a browser tab (Chrome, Safari, Arc, Edge, Brave, Firefox) or as the Chrome PWA ("Install Google Meet" in Chrome's address bar, which lands in `~/Applications/Chrome Apps.localized/Google Meet.app`). Everything Quorum reads comes from the browser through Accessibility (AX) and from the browser's audio processes through the Core Audio process tap.

## Detection

**Window titles.** The tab title is `Meet – abc-defg-hij` (en dash) from the lobby ("Ready to join?") onward; the home page is titled `Google Meet`. Browsers decorate the window title: Chrome appends ` - Google Chrome` and, with several profiles, ` - <profile name>`; Brave appends ` - Brave`; Edge ` - Microsoft Edge`; Firefox an em dash and ` Mozilla Firefox`; Safari and Arc show the tab title alone. `MeetProvider` in `helper/Sources/QuorumHelper/MeetingProviders.swift` matches `^Meet\s[–-]\s(.+?)` and strips the browser suffix. The PWA's bundle id starts with `com.google.Chrome.app.`, so the Chrome prefix covers it.

**Lobby versus call.** The title is the same before and after joining, so the helper looks inside the window for a button labeled "Leave call" (in call) or "Join now" / "Ask to join" (lobby). If neither button is exposed, the title alone counts as a call.

**Getting the web tree.** Chromium builds its web accessibility tree only once an assistive client asks. The helper sets `AXManualAccessibility` on the browser's application element, which Chromium honors without the window management side effects of `AXEnhancedUserInterface`. Verified today: `QuorumHelper dump-ax com.google.Chrome` against Chrome with `meet.google.com/home` open printed the `AXWebArea`, the "Enter a code or link" text field and the "New meeting" button, so page content is readable. Safari and Firefox expose their trees without the attribute (Safari not yet verified here).

**Verified on 2026-11-08:** title matching, browser suffix stripping, web-tree exposure in Chrome on the Meet home page. **Not verified:** a live call. No Meet call was available, so the "Leave call" button label, the lobby buttons and the participant count are from Meet's current UI as remembered and need a `dump-ax com.google.Chrome` during a real call.

## Audio capture

Browsers play audio from helper processes, so `tapBundles` are prefixes, passed from `app/main.js` (`PROVIDERS.meet.bundles`):

| Browser | Prefix | Notes |
|---|---|---|
| Chrome and Chrome PWAs | `com.google.Chrome` | covers `com.google.Chrome.helper` and `com.google.Chrome.app.*` |
| Safari | `com.apple.Safari`, `com.apple.WebKit` | Safari renders audio in `com.apple.WebKit.GPU`; both prefixes needed |
| Arc | `company.thebrowser.Browser` | |
| Edge | `com.microsoft.edgemac` | covers Edge PWAs |
| Brave | `com.brave.Browser` | |
| Firefox | `org.mozilla` | content processes are `org.mozilla.plugincontainer` |
| Vivaldi, Opera | `com.vivaldi.Vivaldi`, `com.operasoftware.Opera` | |

Trade-off: the tap hears every tab of that browser, so music in another tab lands in the "them" track. Narrowing to the one tab is not possible with a process tap; the per-tab audio runs in a shared browser audio service. `SystemTap` already falls back to all system audio when none of the prefixes is running.

## What AX exposes

| Field | Where | Status |
|---|---|---|
| Call code | window title | works (P0) |
| Meeting name | page text next to the code in the bottom bar during a call | unverified, not read yet |
| Participant count | number beside the "People" / "Show everyone" button | best effort via `Providers.countNear`, unverified |
| Participant names | the People side panel, only when open | not read; P1 follow-up |
| In-meeting chat | the Chat side panel: a list of messages and a "Send a message" text field | not read; P2 |

A Meet call code ("abc-defg-hij") is treated as a generic title in `main.js` (`genericTitle`), so the end-of-call notes get a written title.

## STOP/GO notice

Posting in the Meet chat needs the Chat panel open (button "Chat with everyone"), the "Send a message" text field set via `AXValue`, and Return. That is the same shape as the Zoom path in `ChatWatcher`, and it is untested, so today `MeetProvider.canPostNotice` is `false`.

Fallback in place: when the active provider cannot post, `startListening` in `main.js` skips the chat post, starts capture when you confirm (the popup or Start listening), shows the on-screen "listening" card as the visible notice, logs "no in-call notice went out", and the saved note's frontmatter records `platform: Google Meet` and `notice: not posted (...)`. STOP and GO from the chat are also unavailable until P2; the tray and the app still stop it.

## Phases

- **P0 detect + capture (done, live call unverified):** `MeetProvider` title match, lobby check, `AXManualAccessibility`, browser prefixes in `PROVIDERS.meet.bundles`, `meeting` event carries `app: "Google Meet"` and `provider: "meet"`, Settings row, `dump-ax` and `detect` helper commands.
- **P1 title + participants:** run `dump-ax com.google.Chrome` in a live call; read the meeting name from the bottom bar; confirm the People count element; read names from the People panel when it is open. Verify Safari and Arc trees.
- **P2 chat notice:** open the Chat panel through its button, post via `AXValue` + Return, confirm the message appears in the list, read STOP/GO from the list; then flip `canPostNotice` and let `ChatWatcher` route by provider.

## Related

- [[quorum]]
- [[microsoft-teams]]

## Status 2026-11-08 (live test in an empty meeting)

- **Detection verified.** A live call is a window whose active tab has the Meet title and a "Leave call" button. The lobby, the "You left the meeting" page and the Meet home page share the title and are correctly ignored. Several tabs can carry the title at once (a call left earlier keeps it); the helper tries each when it needs to raise one.
- **Chat notice verified (P2 done, best effort).** `MeetChat.swift` opens the side panel ("Chat with everyone"), sets the "Send a message" composer, presses the "Send a message" button and confirms the bubble. Reading works too: bubbles are `AXStaticText` under a time stamp group inside the "Side panel" landmark. Live run: two existing messages read back, the notice posted and read back as sent by "You".
- **Known limits.** A browser exposes only the active tab of each window, so STOP and GO replies are read only while the Meet tab is in front (where the user is during a call); posting raises the tab itself. Other people's sender lines are parsed as the text that shares a parent with the time stamp; that shape is unverified until a second participant writes in the chat. Teams chat is still unimplemented.
- **Audio.** In-browser Meet is tapped through the browser's helper processes, so other tabs playing audio are heard too.


## Status 2026-11-10 (live test, Meet with the Gemini side panel)

- **Meet changed two labels.** The composer reads "History is on" or "History is off" (after the chat history setting) instead of "Send a message", and the Send button is enabled only after Meet registers typed input. `MeetChat.input` accepts either label and `send` presses Return in the browser when Send stays disabled after the `AXValue` set.
- **The Gemini panel is a trap.** Meet opens with an "Ask Gemini" side panel whose box is also an `AXTextArea`. A composer match loose enough to take "any text area" posts the notice to Gemini, which answers "Understood". The composer match is now the two chat labels only, and the chat panel is opened whenever that composer is absent.
- **Depths.** The chat panel sits about forty levels down (composer and Send at depth 40 in a plain call, 23 with Gemini open). All chat walks go to depth 60.
- **Retries never double-post.** `send` checks for the bubble before posting; an emptied composer counts as sent when the bubble cannot be read.
- **Measured.** Post plus bubble confirmation: 0.75 s. Read-back lists the notice as sent by "You".
- **Participant count read 0** in a one-person call (`meetingInfo` event). P1 still open.
