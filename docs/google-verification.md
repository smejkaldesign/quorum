# Submitting Quorum's Google OAuth app for verification

Quorum's Google client (the Desktop client `247537775138-ms93108a3kv4a50ulnnia80ipfs1hha6.apps.googleusercontent.com`) asks for three kinds of access:

| Scope | Class | Review |
|---|---|---|
| `openid`, `.../auth/userinfo.email` | non-sensitive | none |
| `https://www.googleapis.com/auth/drive.file` | non-sensitive | none beyond brand verification |
| `https://www.googleapis.com/auth/calendar.readonly` | sensitive | sensitive scope verification (free, no security assessment) |

While the app is in Testing, only listed test users can connect, and Google expires their refresh tokens after 7 days, so Google Calendar and Google Drive stop working for them every week. Publishing the app to production with `calendar.readonly` needs Google's verification. No scope here is restricted, so no CASA security assessment applies. This page is the full submission, in console order, with the text to paste.

## 1. Before you open the form

Each item below is something a reviewer checks. Fix any that fail first; a submission that fails one comes back by email and the wait starts again.

1. **The home page links the full privacy policy.** Google requires the privacy policy linked on the home page to be the same URL as the one on the consent screen. Today the site footer on `https://quorum.watch` links `/privacy` and `/terms`, and both of those pages say "Coming before the first Cloud release". The full policies are at `https://quorum.watch/legal/privacy` and `https://quorum.watch/legal/terms`. Before submitting, either change the footer links in `site/index.html` (and the other site pages) to `/legal/privacy` and `/legal/terms`, or replace the two placeholder pages with the full policies. The rest of this page uses the `/legal/` URLs.
2. **The privacy policy covers Google user data.** This change adds a "Google user data" section to `site/legal/privacy/index.html`: what each scope reads, that tokens stay in the Mac's Keychain, how to revoke, and the Limited Use disclosure Google asks for ("Quorum's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements"). Deploy the site with that section before submitting. The legal pages carry `noindex`; that does not block review, since reviewers open the URL directly.
3. **The domain is verified.** In Google Search Console (`https://search.google.com/search-console`), signed in as an owner or editor of the Google Cloud project, add the domain property `quorum.watch` and verify it with the DNS TXT record Search Console shows. A URL-prefix property for `https://quorum.watch` also works.
4. **The home page describes the app.** `https://quorum.watch` must say what Quorum does, name it Quorum (the same name as the consent screen), and be reachable without signing in. It does today.
5. **The project contacts are current.** IAM and Admin, IAM: the project owner's address receives every verification email. Google Auth Platform, Branding, Developer contact information: list an address you read daily.
6. **A logo file.** Square PNG or JPG, 120 by 120 pixels, under 1 MB, the Quorum owl as on the site. `site/assets/quorum-filled.svg` is the source; export it centered on the site background `#0b0b0c` with about 16 px of padding. Changing the logo later sends the app back through brand verification, so upload the final one.

## 2. Google Cloud console steps

Open `https://console.cloud.google.com/auth/overview` with the project that holds the Desktop client selected.

### Branding (Google Auth Platform, Branding)

| Field | Value |
|---|---|
| App name | `Quorum` |
| User support email | the support address you want people to write to |
| App logo | the 120 by 120 file from step 1.6 |
| Application home page | `https://quorum.watch` |
| Application privacy policy link | `https://quorum.watch/legal/privacy` |
| Application terms of service link | `https://quorum.watch/legal/terms` |
| Authorized domains | `quorum.watch` |
| Developer contact information | the address from step 1.5 |

Save. Google starts brand verification when the app is published or submitted; it usually takes two to three business days.

### Audience (Google Auth Platform, Audience)

1. User type: **External**.
2. Publishing status: choose **Publish app**, then confirm. Google shows that the app needs verification because it requests a sensitive scope. Until verification passes, people outside the test user list see Google's "unverified app" warning and the 100-user cap applies; test users keep working.

### Data Access (Google Auth Platform, Data Access)

Add or remove scopes, and make sure the list is exactly these four, with nothing else:

- `openid`
- `.../auth/userinfo.email`
- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/calendar.readonly`

Remove any scope the app does not request. Reviewers reject a submission that lists scopes the app never asks for.

When the page asks how each sensitive scope is used, paste the justification below. If it asks for `drive.file`, paste that one too.

**`calendar.readonly` justification (paste as is):**

> Quorum is a macOS app that takes notes in a person's meetings and keeps them as markdown files. When the person connects Google Calendar in Settings, Connections, Quorum reads the events on the calendars they have selected in Google Calendar, from now to a few days ahead. It uses each event's title, start and end time, meeting link, location, description and attendee list for three features: the Up next list on the Home screen, which shows upcoming meetings and joins a call from its meeting link; starting the recording for the right meeting; and naming the people on a call so the transcript and notes show who spoke. To find the calendars the person has selected, Quorum reads their calendar list (the calendarList resource and its selected flag), then the events on those calendars. Quorum never creates, changes or deletes events, so it requests the read-only scope. Narrower scopes do not cover this: calendar.events.readonly does not include the calendar list, so Quorum could not tell which calendars the person shows in Google Calendar, and calendar.freebusy returns only busy times without titles, meeting links or attendees, which the three features need. Events are read on the person's Mac and kept only in the app's memory; the OAuth tokens are stored in the Mac's Keychain and never sent to our servers.

**`drive.file` justification (only if asked):**

> Quorum uses drive.file so that a knowledge base admin can add individual Google Docs, markdown or text files to a shared knowledge base. The admin picks the files with the Google Picker; Quorum can then read only those files and no others. Quorum exports each picked Google Doc as markdown and stores it as a note in the knowledge base the admin chose, and reads it again only when the admin chooses Sync now. Quorum never lists, changes or deletes files in Drive.

### Verification Center (Google Auth Platform, Verification Center)

1. Choose **Prepare for verification** (or **Submit for verification**). Confirm the branding and scopes it shows.
2. Paste the YouTube link to the demo video (section 3).
3. In the additional information box, paste:

> Quorum is a desktop app for macOS distributed from https://quorum.watch, using a Desktop OAuth client with PKCE and the loopback redirect. Google Calendar and Google Drive are separate connections in Settings, Connections; each requests only its own scope, so the Calendar consent screen in the video shows calendar.readonly with openid and email, and the Drive consent screen shows drive.file with openid and email. The privacy policy section "Google user data" at https://quorum.watch/legal/privacy describes each scope's use and includes the Limited Use disclosure.

4. Submit. Google sends a confirmation email to the project contacts.

## 3. Demo video

### Requirements

- Upload to YouTube as **Unlisted**, so reviewers can open it without a sign-in. One video covers both scopes; two to four minutes is enough.
- Show the same app that is submitted: the name Quorum and its owl icon on screen.
- Show the complete OAuth consent screen with the exact scopes requested, with the language selector at the bottom left of Google's screen set to English.
- Show the browser's address bar on the consent screen long enough to read the `client_id=247537775138-...` parameter, so reviewers can match the video to the project.
- Show each feature that uses the scopes, end to end.
- Record at 1080p or higher with the window large enough to read. A voice-over or on-screen captions help; neither is required.
- Use a test Google account whose calendar has two or three upcoming events with Google Meet links, so the Up next list has something to show. Use example names only.

### Shot list

1. **The app.** Quorum open on the Home screen, before Google Calendar is connected. Caption: "Quorum, a macOS meeting notes app."
2. **The connection page.** Open Settings, Connections. Point to the Google Calendar row and its scope line: "calendar.readonly: Quorum reads events and never writes to your calendar." Choose Connect.
3. **The consent screen.** The browser opens Google's account chooser, then the consent screen. Pause on it: the app name Quorum, the "See and download any calendar you can access using your Google Calendar" line, and the email permission. Show the address bar with the client id. Set the language to English if it is not. Choose Continue.
4. **The return.** The browser shows Quorum's "Connected to Google Calendar" page. Switch back to the app: the Google Calendar row shows Connected and the account email.
5. **The calendar data in use.** Go to Home. Show the Up next list with the test events, their titles and times. Join one meeting from its Meet link, or open the event, to show the meeting link in use. If you can, start a short recording in a test meeting and show the attendee names in the participant list.
6. **Read only.** Caption: "Quorum never creates, changes or deletes calendar events." Show the event in Google Calendar unchanged.
7. **Google Drive (drive.file).** In Settings, Connections, Accounts, connect Google Drive and show its consent screen with "See, edit, create and delete only the specific Google Drive files you use with this app." Then open Settings, Admin, Knowledge, a knowledge base's menu, Add from Google Drive, and Choose files in Google Drive. The Google Picker opens in the browser; pick one Google Doc. Back in the app, show the file in the knowledge base with its last synced time, then Sync now.
8. **Disconnect.** In Settings, Connections, disconnect Google Calendar. Caption: "Disconnecting deletes the tokens from the Mac and revokes access with Google." Optionally show `https://myaccount.google.com/permissions` without Quorum listed.

## 4. What to expect

- **Emails.** Everything arrives at the project owner and the developer contact, from an address at google.com, with a subject that names the project. Reply in the same thread; a new thread starts a new queue position. Google often asks for one of: a clearer justification, the client id visible in the video, a privacy policy wording change, or removal of an unused scope. Each reply restarts that step's review.
- **Timeline.** Brand verification: about two to three business days. Sensitive scope review: a few days to several weeks; four to six weeks is common for a first submission. The Verification Center page shows the current status.
- **During review.** The app keeps working for test users. New users outside the test list see the unverified app warning and the 100-user cap applies. Add anyone who needs Google Calendar before approval as a test user under Audience.
- **After approval.** The unverified app warning and the user cap go away, and refresh tokens no longer expire after 7 days. Nothing changes in the app or the build. If the scopes, the app name, the logo or the home page change later, the app goes through verification again for that change.
- **Yearly.** Sensitive scopes have no annual assessment. Google may email a request to re-confirm compliance; answer it from the same thread.

## Related

- `docs/oauth-apps.md`: the Google client, the Picker key and where each value goes.
- `docs/specs/workspace-knowledge.md`, "Google verification cost".
- `site/legal/privacy/index.html`, "Google user data".
