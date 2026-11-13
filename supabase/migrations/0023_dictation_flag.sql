-- applied-when: select exists (select 1 from public.feature_flags where key = 'dictation')
-- Dictation (voice typing anywhere with the dictation shortcut) gets its own switch, off, under manual listening.
-- While it is off the app hides the Voice typing settings and the shortcut does nothing.
insert into public.feature_flags (key, name, description, enabled, tags, requires) values
  ('dictation', 'Dictation', 'Voice typing anywhere with the dictation shortcut', false, '{listening}', 'manual-listen')
on conflict (key) do nothing;
