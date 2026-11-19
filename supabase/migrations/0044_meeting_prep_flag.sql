-- applied-when: select exists (select 1 from public.feature_flags where key = 'meeting-prep')
-- meeting-prep, off, shows the Meeting prep settings and the prep note an Up next event opens to (app/meetingPrep.js).
insert into public.feature_flags (key, name, description, enabled, tags) values
  ('meeting-prep', 'Meeting prep notes', 'A prep note for upcoming meetings, built from the vault with the person''s own model and saved into the vault', false, '{calendar}')
on conflict (key) do nothing;
