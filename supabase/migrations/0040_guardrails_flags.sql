-- applied-when: select exists (select 1 from public.feature_flags where key = 'guardrails') and exists (select 1 from public.feature_flags where key = 'guardrails-custom')
-- Guardrails get two switches. guardrails, on, shows the Guardrails page in Settings, Admin; with it off the page leaves
-- the nav and the built-in guards keep running, since the switch only hides the page. guardrails-custom, off, needs
-- guardrails: it shows the rules beyond the built-in ones (the Agent OS rules, the person's own rules, the
-- organization or team rules), the Your rules section and the Try a path tool. Until it is on, the person's own Agent
-- OS defines any rule beyond the built-in ones.
insert into public.feature_flags (key, name, description, enabled, tags) values
  ('guardrails', 'Guardrails', 'The Guardrails page in Settings, Admin. The built-in guards run either way.', true, '{guardrails}')
on conflict (key) do nothing;
insert into public.feature_flags (key, name, description, enabled, tags, requires) values
  ('guardrails-custom', 'Custom guardrails', 'Rules beyond the built-in ones on the Guardrails page: Agent OS, personal and organization rules, and the Try a path tool', false, '{guardrails}', 'guardrails')
on conflict (key) do nothing;
