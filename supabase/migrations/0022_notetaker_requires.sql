-- applied-when: select coalesce((select requires = 'manual-listen' from public.feature_flags where key = 'meeting-capture'), false) and coalesce((select requires = 'manual-listen' from public.feature_flags where key = 'live-assist'), false)
-- Every notetaker surface needs manual listening: call detection and live assistance only make sense while Quorum can
-- listen, so turning manual-listen off in the admin app turns them off too. screen-context already needs it (0021).
update public.feature_flags set requires = 'manual-listen', updated_at = now()
  where key in ('meeting-capture', 'live-assist') and requires is distinct from 'manual-listen';
