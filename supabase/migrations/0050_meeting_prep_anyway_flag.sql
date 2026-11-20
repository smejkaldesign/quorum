-- applied-when: select exists (select 1 from public.feature_flags where key = 'meeting-prep-anyway')
-- meeting-prep-anyway, on, shows Generate anyways on a meeting page with fewer past meetings than the threshold and
-- lets it write one-off prep notes with the person's own model (app/meetingOneOff.js). Turning it off hides the button
-- and stops those model calls on every install.
insert into public.feature_flags (key, name, description, enabled, tags) values
  ('meeting-prep-anyway', 'Generate prep anyways', 'Prep notes on request for a meeting with fewer than 3 past meetings, written from the invite and the vault with the person''s own model', true, '{calendar}')
on conflict (key) do nothing;
