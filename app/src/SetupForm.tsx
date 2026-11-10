import type { SetupAnswers, SetupTemplate } from './quorum';

// the setup interview: a template and five short answers that shape a Quorum-built Agent OS. Shared by onboarding
// (first creation) and Settings, Memory (run again). Lists are typed as comma-separated text and split on save
export const TEMPLATE_INFO: { id: SetupTemplate; name: string; desc: string }[] = [
  { id: 'personal', name: 'Personal', desc: 'Inbox, daily notes, people, projects, knowledge, meetings' },
  { id: 'founder', name: 'Founder', desc: 'Adds a company area, customers and a decisions log' },
  { id: 'team-lead', name: 'Team lead', desc: 'Adds one-on-ones and a note per report' },
];

export type SetupDraft = { template: SetupTemplate; role: string; goals: string; projects: string; people: string; organize: 'areas' | 'plain' };
export const emptyDraft = (): SetupDraft => ({ template: 'personal', role: '', goals: '', projects: '', people: '', organize: 'areas' });
export const draftFrom = (a: Partial<SetupAnswers> | null | undefined): SetupDraft => ({
  template: a?.template ?? 'personal', role: a?.role ?? '', goals: a?.goals ?? '', projects: (a?.projects ?? []).join(', '), people: (a?.people ?? []).join(', '), organize: a?.organize === 'plain' ? 'plain' : 'areas',
});
const split = (s: string) => s.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
export const answersFrom = (d: SetupDraft): SetupAnswers => ({ template: d.template, role: d.role.trim(), goals: d.goals.trim(), projects: split(d.projects), people: split(d.people), organize: d.organize });
export const draftIsEmpty = (d: SetupDraft) => !d.role.trim() && !d.goals.trim() && !d.projects.trim() && !d.people.trim();

export function SetupForm({ draft, onChange, note }: { draft: SetupDraft; onChange: (d: SetupDraft) => void; note?: string | null }) {
  const set = <K extends keyof SetupDraft>(k: K, v: SetupDraft[K]) => onChange({ ...draft, [k]: v });
  return (
    <div className="setup-form">
      {note && <p className="setup-note">{note}</p>}
      <div className="setup-tiles" role="radiogroup" aria-label="Template">
        {TEMPLATE_INFO.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={draft.template === t.id} className={`onb-tile setup-tile ${draft.template === t.id ? 'on' : ''}`} onClick={() => set('template', t.id)}>
            <span><strong>{t.name}</strong><em>{t.desc}</em></span>
          </button>
        ))}
      </div>
      <label className="set-field wide onb-field"><span className="onb-label">Your role</span><input value={draft.role} placeholder="Product designer at a small studio" onChange={(e) => set('role', e.target.value)} /></label>
      <label className="set-field wide onb-field"><span className="onb-label">Working toward</span><input value={draft.goals} placeholder="Ship the first version this quarter" onChange={(e) => set('goals', e.target.value)} /></label>
      <label className="set-field wide onb-field"><span className="onb-label">Projects</span><input value={draft.projects} placeholder="Names, separated by commas" onChange={(e) => set('projects', e.target.value)} /></label>
      <label className="set-field wide onb-field"><span className="onb-label">People</span><input value={draft.people} placeholder="Who you work with, separated by commas" onChange={(e) => set('people', e.target.value)} /></label>
      <div className="onb-row setup-organize">
        <span className="onb-label">Folders</span>
        <span className="seg" role="radiogroup" aria-label="Folder names">
          <button type="button" role="radio" aria-checked={draft.organize === 'areas'} className={draft.organize === 'areas' ? 'on' : ''} onClick={() => set('organize', 'areas')}>Numbered areas</button>
          <button type="button" role="radio" aria-checked={draft.organize === 'plain'} className={draft.organize === 'plain' ? 'on' : ''} onClick={() => set('organize', 'plain')}>Plain names</button>
        </span>
        <code className="setup-example">{draft.organize === 'areas' ? '02-people/, 03-projects/' : 'people/, projects/'}</code>
      </div>
      <p className="setup-privacy">Each project and person gets a note, and the answers go into the folder's CLAUDE.md and <code>.quorum/setup.json</code>. Nothing leaves this Mac.</p>
    </div>
  );
}
