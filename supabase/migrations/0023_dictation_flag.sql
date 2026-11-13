-- applied-when: select exists (select 1 from public.feature_flags where key = 'dictation')
-- Dictation (the composer's dictate button and its shortcut) gets its own switch, off, under manual listening. While
-- it is off the app hides voice typing; the Dictionary stays, since transcripts use it too. manual-listen's
-- description drops dictation.
insert into public.feature_flags (key, name, description, enabled, tags, requires) values
  ('dictation', 'Dictation', 'Voice typing in the composer with the dictate button and its shortcut', false, '{listening}', 'manual-listen')
on conflict (key) do nothing;
update public.feature_flags set description = 'Start listening, the live transcript, the running summary and the note a session writes', updated_at = now()
  where key = 'manual-listen' and description like '%dictation%';
