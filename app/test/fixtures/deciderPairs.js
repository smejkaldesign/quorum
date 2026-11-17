// Synthetic claim pairs and notes for the decision layer (decide/). Every name and fact is made up. truth is the label a
// careful judge would give: contradiction, refinement and different_times make a finding, so dropping one is an error;
// same, different_scope and unrelated close without a finding, so dropping one saves a judge call.
const c = (rel, quote, subject, attribute, value, polarity = 'positive') => ({ rel, quote, subject, attribute, value, polarity });
const P = (truth, a, b) => ({ truth, a, b });

export const PAIRS = [
  // unrelated: the pairer joined them on a shared subject and a fuzzy attribute, but they speak of different things
  P('unrelated', c('a.md', 'Atlas stores user uploads in an S3 bucket.', 'atlas', 'storage', 'S3 bucket'), c('b.md', 'Atlas standups happen on Tuesday mornings.', 'atlas', 'standup', 'Tuesday mornings')),
  P('unrelated', c('a.md', 'The mobile app uses React Native for its interface.', 'mobile app', 'framework', 'React Native'), c('b.md', 'The mobile app onboarding has three screens.', 'mobile app', 'flow', 'three screens')),
  P('unrelated', c('a.md', 'Billing sends invoices through the payment provider.', 'billing', 'invoices', 'payment provider'), c('b.md', 'Billing owns the refund policy page on the help site.', 'billing', 'invoice page', 'refund policy page')),
  P('unrelated', c('a.md', 'The design system ships a dark theme.', 'design system', 'theme', 'dark theme'), c('b.md', 'The design system documentation lives in the handbook.', 'design system', 'themes doc', 'handbook')),
  P('unrelated', c('a.md', 'Search indexes notes every night.', 'search', 'index schedule', 'every night'), c('b.md', 'Search shows a spinner while results load.', 'search', 'index state', 'spinner')),
  P('unrelated', c('a.md', 'The helper app asks for microphone access at first launch.', 'helper app', 'permission', 'microphone'), c('b.md', 'The helper app is written in Swift.', 'helper app', 'permissions', 'Swift')),
  P('unrelated', c('a.md', 'Orion support tickets go to the shared inbox.', 'orion', 'support', 'shared inbox'), c('b.md', 'Orion supports single sign-on through the identity provider.', 'orion', 'supports', 'single sign-on')),
  P('unrelated', c('a.md', 'The data team publishes a weekly metrics digest.', 'data team', 'report', 'weekly metrics digest'), c('b.md', 'The data team reports to the head of engineering.', 'data team', 'reports', 'head of engineering')),
  P('unrelated', c('a.md', 'Website hosting runs on a static file service.', 'website', 'hosting', 'static file service'), c('b.md', 'The website hosts a careers page with open roles.', 'website', 'hosts', 'careers page')),
  P('unrelated', c('a.md', 'The editor autosaves drafts while you type.', 'editor', 'save', 'autosave'), c('b.md', 'The editor has a keyboard shortcut list under Help.', 'editor', 'shortcut', 'Help menu')),
  P('unrelated', c('a.md', 'Field notes are tagged with the visit location.', 'field notes', 'tag', 'visit location'), c('b.md', 'Field notes are reviewed by the research lead.', 'field notes', 'tagged by', 'research lead')),
  P('unrelated', c('a.md', 'The release checklist includes a smoke test of sign in.', 'release checklist', 'step', 'smoke test of sign in'), c('b.md', 'The release checklist is kept in the wiki.', 'release checklist', 'steps location', 'wiki')),

  // same: one fact said in other words
  P('same', c('a.md', 'Atlas uses Postgres as its main database.', 'atlas', 'database', 'Postgres'), c('b.md', 'The primary database for Atlas is Postgres.', 'atlas', 'database', 'PostgreSQL')),
  P('same', c('a.md', 'The team chose Figma for design work.', 'team', 'design tool', 'Figma'), c('b.md', 'Design work at the team happens in Figma.', 'team', 'design tool', 'Figma for design')),
  P('same', c('a.md', 'Orion is owned by the platform group.', 'orion', 'owner', 'platform group'), c('b.md', 'The platform group owns Orion.', 'orion', 'owner', 'the platform group')),
  P('same', c('a.md', 'The mobile app requires sign in before use.', 'mobile app', 'sign in', 'required'), c('b.md', 'Users must sign in to use the mobile app.', 'mobile app', 'sign in', 'must sign in')),
  P('same', c('a.md', 'Weekly planning happens on Monday.', 'planning', 'day', 'Monday'), c('b.md', 'Planning meetings are held every Monday.', 'planning', 'day', 'every Monday')),
  P('same', c('a.md', 'The design system is maintained by the design team.', 'design system', 'maintainer', 'design team'), c('b.md', 'The design team maintains the design system.', 'design system', 'maintainer', 'the design team')),
  P('same', c('a.md', 'Search is powered by a local full text index.', 'search', 'engine', 'local full text index'), c('b.md', 'A local full text index powers search.', 'search', 'engine', 'full text index, local')),
  P('same', c('a.md', 'The website is built with a static site generator.', 'website', 'build', 'static site generator'), c('b.md', 'A static site generator builds the website.', 'website', 'build', 'a static site generator')),
  P('same', c('a.md', 'Support replies within one business day.', 'support', 'response time', 'one business day'), c('b.md', 'Support answers every ticket within one business day.', 'support', 'response time', 'within one business day')),
  P('same', c('a.md', 'The helper app runs only on macOS.', 'helper app', 'platform', 'macOS'), c('b.md', 'macOS is the only platform the helper app runs on.', 'helper app', 'platform', 'macOS only')),

  // different_scope: both true, about different parts of the subject
  P('different_scope', c('a.md', 'For the team plan, Orion costs 10 dollars a seat.', 'orion', 'price', '10 dollars a seat'), c('b.md', 'For the enterprise plan, Orion costs 25 dollars a seat.', 'orion', 'price', '25 dollars a seat')),
  P('different_scope', c('a.md', 'In Europe, Atlas data is stored in Frankfurt.', 'atlas', 'data region', 'Frankfurt'), c('b.md', 'In the United States, Atlas data is stored in Virginia.', 'atlas', 'data region', 'Virginia')),
  P('different_scope', c('a.md', 'On iOS the mobile app uses Swift.', 'mobile app', 'language', 'Swift'), c('b.md', 'On Android the mobile app uses Kotlin.', 'mobile app', 'language', 'Kotlin')),
  P('different_scope', c('a.md', 'The marketing site uses a blue accent color.', 'brand', 'accent color', 'blue'), c('b.md', 'The product app uses a green accent color.', 'brand', 'accent color', 'green')),
  P('different_scope', c('a.md', 'Internal docs are written in the wiki.', 'docs', 'location', 'wiki'), c('b.md', 'Public docs are written in the docs site repository.', 'docs', 'location', 'docs site repository')),
  P('different_scope', c('a.md', 'The free tier keeps history for 30 days.', 'history', 'retention', '30 days'), c('b.md', 'The paid tier keeps history for one year.', 'history', 'retention', 'one year')),
  P('different_scope', c('a.md', 'Backend services are deployed with containers.', 'deploy', 'method', 'containers'), c('b.md', 'The website is deployed as static files.', 'deploy', 'method', 'static files')),
  P('different_scope', c('a.md', 'Engineering hires go through a take home exercise.', 'hiring', 'process', 'take home exercise'), c('b.md', 'Design hires go through a portfolio review.', 'hiring', 'process', 'portfolio review')),

  // contradiction: the two cannot both hold
  P('contradiction', c('a.md', 'Atlas will use Postgres for its database.', 'atlas', 'database', 'Postgres'), c('b.md', 'Atlas moved off Postgres and now uses MySQL.', 'atlas', 'database', 'MySQL')),
  P('contradiction', c('a.md', 'The launch date for Orion is March 3.', 'orion', 'launch date', 'March 3'), c('b.md', 'Orion launches on April 10.', 'orion', 'launch date', 'April 10')),
  P('contradiction', c('a.md', 'The team decided to build the app in React Native.', 'mobile app', 'framework', 'React Native'), c('b.md', 'The team decided to build the app natively and dropped React Native.', 'mobile app', 'framework', 'native')),
  P('contradiction', c('a.md', 'Support is available around the clock.', 'support', 'hours', 'around the clock'), c('b.md', 'Support is only available during business hours.', 'support', 'hours', 'business hours only')),
  P('contradiction', c('a.md', 'The website is hosted on our own servers.', 'website', 'hosting', 'own servers'), c('b.md', 'The website is no longer self hosted; it runs on a managed host.', 'website', 'hosting', 'managed host')),
  P('contradiction', c('a.md', 'Dark mode is enabled by default.', 'app', 'dark mode default', 'enabled'), c('b.md', 'Dark mode is off by default.', 'app', 'dark mode default', 'off')),
  P('contradiction', c('a.md', 'Priya leads the Atlas project.', 'atlas', 'lead', 'Priya'), c('b.md', 'Marcus is the lead of the Atlas project.', 'atlas', 'lead', 'Marcus')),
  P('contradiction', c('a.md', 'The data team uses Python for pipelines.', 'data team', 'pipeline language', 'Python'), c('b.md', 'The data team rewrote every pipeline in Scala and stopped using Python.', 'data team', 'pipeline language', 'Scala')),
  P('contradiction', c('a.md', 'Meeting notes are private by default.', 'meeting notes', 'default visibility', 'private'), c('b.md', 'Meeting notes are shared with the whole workspace by default.', 'meeting notes', 'default visibility', 'shared with the workspace')),
  P('contradiction', c('a.md', 'The helper app is signed with a developer certificate.', 'helper app', 'signing', 'developer certificate'), c('b.md', 'The helper app ships unsigned.', 'helper app', 'signing', 'unsigned')),
  P('contradiction', c('a.md', 'We keep backups for 90 days.', 'backups', 'retention', '90 days'), c('b.md', 'Backups are kept for 30 days.', 'backups', 'retention', '30 days')),
  P('contradiction', c('a.md', 'The editor saves files as Markdown.', 'editor', 'file format', 'Markdown'), c('b.md', 'The editor saves files as HTML.', 'editor', 'file format', 'HTML')),
  P('contradiction', c('a.md', 'Search runs in the cloud.', 'search', 'location', 'cloud'), c('b.md', 'Search runs entirely on the device.', 'search', 'location', 'on the device')),
  P('contradiction', c('a.md', 'The free plan includes team folders.', 'free plan', 'team folders', 'included'), c('b.md', 'The free plan does not include team folders.', 'free plan', 'team folders', 'included', 'negative')),

  // refinement: the newer claim adds detail; Quorum suggests a link, so a drop loses a finding
  P('refinement', c('a.md', 'Atlas uses Postgres.', 'atlas', 'database', 'Postgres'), c('b.md', 'Atlas uses Postgres 16 with read replicas in two regions.', 'atlas', 'database', 'Postgres 16 with read replicas')),
  P('refinement', c('a.md', 'The mobile app supports offline mode.', 'mobile app', 'offline', 'supported'), c('b.md', 'The mobile app supports offline mode for notes and tasks, with sync on reconnect.', 'mobile app', 'offline', 'notes and tasks, sync on reconnect')),
  P('refinement', c('a.md', 'Support uses a shared inbox.', 'support', 'channel', 'shared inbox'), c('b.md', 'Support uses a shared inbox with tags for billing and bugs.', 'support', 'channel', 'shared inbox with tags')),
  P('refinement', c('a.md', 'The design system has a button component.', 'design system', 'button', 'component'), c('b.md', 'The design system button comes in primary, secondary and ghost variants.', 'design system', 'button', 'primary, secondary and ghost variants')),
  P('refinement', c('a.md', 'Orion sends a weekly email.', 'orion', 'email', 'weekly'), c('b.md', 'Orion sends a weekly email every Friday with the open tasks.', 'orion', 'email', 'weekly on Friday with open tasks')),
  // hard cases: findings a small model can miss. Implicit contradictions with no shared wording, refinements whose
  // detail pulls the wording apart, and changes over time without a number or date in the value
  P('contradiction', c('a.md', 'Atlas is written in Go.', 'atlas', 'language', 'Go'), c('b.md', 'Every Atlas service is a TypeScript project.', 'atlas', 'language', 'TypeScript')),
  P('contradiction', c('a.md', 'Orion is free for every customer.', 'orion', 'pricing', 'free'), c('b.md', 'Customers pay a monthly subscription for Orion.', 'orion', 'pricing', 'monthly subscription')),
  P('contradiction', c('a.md', 'The helper app needs no permissions.', 'helper app', 'permissions', 'none'), c('b.md', 'The helper app asks for microphone and screen recording access.', 'helper app', 'permissions', 'microphone and screen recording')),
  P('contradiction', c('a.md', 'Search results include archived notes.', 'search', 'archived notes', 'included'), c('b.md', 'Archived notes are hidden from search.', 'search', 'archived notes', 'hidden')),
  P('contradiction', c('a.md', 'The design team owns the icon set.', 'icon set', 'owner', 'design team'), c('b.md', 'Engineering maintains the icon set on its own.', 'icon set', 'owner', 'engineering')),
  P('contradiction', c('a.md', 'Sync happens in real time.', 'sync', 'timing', 'real time'), c('b.md', 'Sync runs once a night as a batch job.', 'sync', 'timing', 'nightly batch')),
  P('contradiction', c('a.md', 'The mobile app works without an account.', 'mobile app', 'account', 'not needed'), c('b.md', 'An account is required to open the mobile app.', 'mobile app', 'account', 'required')),
  P('contradiction', c('a.md', 'Exports are available as PDF.', 'exports', 'format', 'PDF'), c('b.md', 'Exports only come out as plain text.', 'exports', 'format', 'plain text only')),
  P('contradiction', c('a.md', 'The website runs on a single server.', 'website', 'servers', 'single server'), c('b.md', 'The website is spread across a cluster in three regions.', 'website', 'servers', 'cluster in three regions')),
  P('contradiction', c('a.md', 'Field interviews are recorded on video.', 'interviews', 'recording', 'video'), c('b.md', 'Interviews are captured as handwritten notes only.', 'interviews', 'recording', 'handwritten notes')),
  P('different_times', c('a.md', 'The team used Jira for tracking.', 'team', 'tracker', 'Jira'), c('b.md', 'The team now tracks work in Linear.', 'team', 'tracker', 'Linear')),
  P('different_times', c('a.md', 'Orion was in private beta.', 'orion', 'stage', 'private beta'), c('b.md', 'Orion is generally available.', 'orion', 'stage', 'generally available')),
  P('different_times', c('a.md', 'Billing was handled by the finance team.', 'billing', 'owner', 'finance team'), c('b.md', 'Billing moved to the platform team.', 'billing', 'owner', 'platform team')),
  P('different_times', c('a.md', 'The editor used to store drafts on the server.', 'editor', 'draft storage', 'server'), c('b.md', 'Drafts are kept on the device.', 'editor', 'draft storage', 'device')),
  P('different_times', c('a.md', 'Atlas ran on virtual machines.', 'atlas', 'hosting', 'virtual machines'), c('b.md', 'Atlas runs on a managed container service.', 'atlas', 'hosting', 'managed containers')),
  P('refinement', c('a.md', 'Search supports filters.', 'search', 'filters', 'supported'), c('b.md', 'You can narrow results by tag, author, folder and the week a note was last edited.', 'search', 'filters', 'tag, author, folder, last edited week')),
  P('refinement', c('a.md', 'The helper app records audio.', 'helper app', 'recording', 'audio'), c('b.md', 'Recording captures the microphone and the system output as two tracks, mixed after the call.', 'helper app', 'recording', 'microphone and system output tracks')),
  P('refinement', c('a.md', 'Support covers billing questions.', 'support', 'scope', 'billing'), c('b.md', 'Refund requests, invoice corrections and plan changes all go through the support queue.', 'support', 'scope', 'refunds, invoices, plan changes')),
  P('refinement', c('a.md', 'Atlas has an API.', 'atlas', 'api', 'available'), c('b.md', 'The REST endpoints return JSON and accept a bearer token issued from settings.', 'atlas', 'api', 'REST, JSON, bearer token')),
  P('refinement', c('a.md', 'The design system covers forms.', 'design system', 'forms', 'covered'), c('b.md', 'Inputs, selects, checkboxes and inline validation messages each have a documented component.', 'design system', 'forms', 'inputs, selects, checkboxes, validation')),
  P('refinement', c('a.md', 'Orion has a mobile client.', 'orion', 'mobile', 'client'), c('b.md', 'The phone app mirrors the task board and adds push reminders for due items.', 'orion', 'mobile', 'task board and push reminders')),
  P('refinement', c('a.md', 'Meeting notes get a summary.', 'meeting notes', 'summary', 'generated'), c('b.md', 'After each call a short recap with decisions and owners is written at the top of the note.', 'meeting notes', 'summary', 'recap with decisions and owners')),

  // more closable pairs, so the drop rate reads on more than a handful
  P('unrelated', c('a.md', 'Orion dashboards refresh every few minutes.', 'orion', 'dashboard', 'refresh'), c('b.md', 'Orion dashboard tiles can be dragged into a new order.', 'orion', 'dashboards', 'drag to reorder')),
  P('unrelated', c('a.md', 'The mobile app sends push notifications for mentions.', 'mobile app', 'notifications', 'mentions'), c('b.md', 'The mobile app notification settings live under Profile.', 'mobile app', 'notification', 'under Profile')),
  P('unrelated', c('a.md', 'Atlas logs go to the central logging service.', 'atlas', 'logs', 'central logging'), c('b.md', 'Atlas login uses magic links sent by email.', 'atlas', 'login', 'magic links')),
  P('unrelated', c('a.md', 'The research team keeps a participant panel.', 'research team', 'panel', 'participants'), c('b.md', 'The research team presents findings at the monthly review.', 'research team', 'panels', 'monthly review')),
  P('unrelated', c('a.md', 'Billing emails use the brand template.', 'billing', 'email', 'brand template'), c('b.md', 'Billing email address changes need a confirmation step.', 'billing', 'email address', 'confirmation step')),
  P('unrelated', c('a.md', 'The editor spell checks in English and Spanish.', 'editor', 'spell check', 'English and Spanish'), c('b.md', 'The editor checks links for broken targets on save.', 'editor', 'checks', 'broken links')),
  P('same', c('a.md', 'Orion is built by the growth team.', 'orion', 'team', 'growth team'), c('b.md', 'The growth team builds Orion.', 'orion', 'team', 'the growth team')),
  P('same', c('a.md', 'Atlas sends a digest email each morning.', 'atlas', 'digest', 'each morning'), c('b.md', 'Every morning Atlas emails a digest.', 'atlas', 'digest', 'every morning')),
  P('same', c('a.md', 'The helper app is open source.', 'helper app', 'license', 'open source'), c('b.md', 'The source code of the helper app is open.', 'helper app', 'license', 'open source code')),
  P('different_scope', c('a.md', 'On desktop the editor uses a sidebar for outlines.', 'editor', 'outline', 'sidebar'), c('b.md', 'On phones the editor shows outlines in a sheet.', 'editor', 'outline', 'sheet')),
  P('different_scope', c('a.md', 'Admins can delete any workspace note.', 'notes', 'delete permission', 'admins, any note'), c('b.md', 'Members can delete only their own notes.', 'notes', 'delete permission', 'members, own notes')),
];

export const NOTES = [
  { rel: 'empty.md', text: '', truth: false },
  { rel: 'front.md', text: '---\ntags: [inbox]\n---\n', truth: false },
  { rel: 'short.md', text: '# Ideas\n\ncall back', truth: true },
  { rel: 'template.md', text: '# {{title}}\n\nDate: {{date}}\n\n## Attendees\n\n{{attendees}}\n\n## Notes\n\n<% tp.file.cursor() %>', truth: false },
  { rel: 'links.md', text: '# Reading\n\n- [[Atlas overview]]\n- [[Orion launch plan]]\n- https://example.com/guide\n- [Style guide](https://example.com/style)', truth: false },
  { rel: 'decision.md', text: '# Atlas database\n\nWe decided to use Postgres for Atlas. The data team owns the schema and reviews every migration.', truth: true },
  { rel: 'meeting.md', text: '---\ndate: 2026-03-02\n---\n# Orion sync\n\n- Launch moved to April 10.\n- Support hours stay at business hours.\n- [[Orion launch plan]]', truth: true },
  { rel: 'templated-real.md', text: '# {{title}}\n\nThe mobile app supports offline mode for notes and tasks. Sync runs when the device reconnects, and conflicts keep both copies for review.', truth: true },
  { rel: 'list.md', text: '# Stack\n\n- Atlas uses Postgres.\n- Search runs on the device.\n- The helper app is written in Swift.', truth: true },
];

// a finding label: dropping a pair with one of these loses what Quorum would show
export const FINDING = new Set(['contradiction', 'refinement', 'different_times']);
