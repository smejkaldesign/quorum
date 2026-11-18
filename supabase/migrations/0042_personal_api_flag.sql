-- applied-when: select exists (select 1 from public.feature_flags where key = 'personal-api')
-- personal-api, off, shows the API section on Settings, Admin, AI tools, where personal API keys will be issued.
insert into public.feature_flags (key, name, description, enabled, tags) values
  ('personal-api', 'Personal API keys', 'The API section on the AI tools page, where people will issue keys for their own scripts', false, '{settings}')
on conflict (key) do nothing;
