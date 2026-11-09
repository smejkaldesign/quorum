import { useEffect, useState } from 'react';
import type { AccountState, Member, VoiceStep, WorkspaceConnector, WorkspaceUsage, WorkspaceVoice } from '../../src/quorum';
import { Row } from '../../src/controls';
import { IconBuilding, IconMic, IconNotes, IconStack, ProviderMark } from '../../src/icons';
import { AccountCard, EE_MARKER, useAccount } from './Account';
import { accountApi, connectorsApi, voiceApi } from './accountMock';
import { PROVIDERS, serving } from './connectorRoles';

const api = voiceApi();
const connectors = connectorsApi();
const account = accountApi();

// the managed pipeline: what each step does, the provider Quorum runs it on by default, and what an hour of audio costs Quorum
export const PIPELINE: { role: VoiceStep; title: string; what: string; provider: string; cost: string; icon: typeof IconMic }[] = [
  { role: 'speech', title: 'Speech to text', what: 'Turns the call audio into a transcript while the meeting runs.', provider: "a cloud speech engine on Quorum's key", cost: '$0.15 to $0.46', icon: IconMic },
  { role: 'summary', title: 'Running summary', what: 'Keeps a short summary current during the call so answers and suggestions have context.', provider: 'Claude Haiku', cost: 'about $0.01', icon: IconStack },
  { role: 'notes', title: 'Final notes', what: 'Writes the meeting notes when the call ends.', provider: 'Claude Sonnet', cost: 'about $0.06', icon: IconNotes },
];
export const INCLUDED_HOURS = 20;
export const SEAT_PRICE = 9;
export const PACK = { hours: 20, price: 5 };

export const hours = (h: number) => (h >= 10 ? Math.round(h).toString() : (Math.round(h * 10) / 10).toString());
// packs the workspace would need on top of the included hours for what it has used so far this period
export const packsFor = (managedHours: number, seats: number) => Math.max(0, Math.ceil((managedHours - seats * INCLUDED_HOURS) / PACK.hours));

export function WorkspaceVoicePage() {
  const a = useAccount();
  if (!a) return null;
  if (!a.signedIn || !a.workspace) return <AccountCard account={a} />;
  return <Voice account={a} />;
}

function Voice({ account: acct }: { account: AccountState }) {
  const ws = acct.workspace!;
  const canManage = ws.role !== 'member';
  const [list, setList] = useState<WorkspaceConnector[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [voice, setVoice] = useState<WorkspaceVoice>({});
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    connectors.connectorsList().then((r) => { if (live && r.connectors) setList(r.connectors); });
    account.membersList().then((r) => { if (live && !('error' in r)) setMembers(r.members); });
    api.workspaceUsage().then((r) => { if (!live) return; if (r.error) setError(r.error); else if (r.usage) setUsage(r.usage); });
    api.workspaceVoiceGet().then((r) => { if (live && r.voice) setVoice(r.voice); });
    return () => { live = false; };
  }, [ws.id]);
  const choose = async (role: VoiceStep, id: string) => {
    const next = { ...voice, [role]: id || null };
    setVoice(next); setError('');
    const r = await api.workspaceVoiceSet(next);
    if (r.error) setError(r.error); else if (r.voice) setVoice(r.voice);
  };
  // every member is a seat; a seat with no usage rows this period shows zeros
  const seats = members.map((m) => ({ ...m, use: usage?.seats.find((s) => s.userId === m.userId) }));
  const period = new Date(usage?.period ?? Date.now()).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const managed = usage?.managedHours ?? 0;
  const own = Math.max(0, (usage?.hours ?? 0) - managed);
  const packs = packsFor(managed, Math.max(members.length, 1));
  return (
    <div data-ee={EE_MARKER}>
      <h3>How Quorum improves voice to text</h3>
      <p className="mcp-lede">Three steps run on Quorum's keys for every seat. Each can move to a connector of your own below.</p>
      <div className="set-card">
        {PIPELINE.map((s) => (
          <Row key={s.role} icon={<s.icon width={18} height={18} />} title={s.title} desc={`${s.what} Default: ${s.provider}.`}>
            <span className="muted voice-cost">{s.cost} per hour</span>
          </Row>
        ))}
      </div>
      <p className="set-note">Each ${SEAT_PRICE} seat includes {INCLUDED_HOURS} hours a month. More comes in {PACK.hours}-hour packs at ${PACK.price}.</p>

      <h3>Usage this period</h3>
      <div className="set-card">
        <Row icon={<IconBuilding width={18} height={18} />} title={ws.name}
          desc={`${period} · ${hours(managed)} of ${members.length * INCLUDED_HOURS || INCLUDED_HOURS} included hours used${own > 0 ? ` · ${hours(own)} on your connectors` : ''}`}>
          <span className="muted">{packs ? `${packs} ${packs === 1 ? 'pack' : 'packs'} this period` : 'No packs needed'}</span>
        </Row>
        {seats.map((s) => (
          <div key={s.userId} className="member-row">
            <span className="member-avatar">{(s.name || s.email)[0].toUpperCase()}</span>
            <div className="set-text"><strong>{s.name || s.email}{s.userId === acct.userId && <em className="stub">You</em>}</strong><span>{s.use && s.use.hours - s.use.managedHours > 0 ? `${hours(s.use.hours - s.use.managedHours)} hours on your connectors` : 'Managed by Quorum'}</span></div>
            <span className="muted">{hours(s.use?.managedHours ?? 0)} of {INCLUDED_HOURS} hours</span>
          </div>
        ))}
        {!members.length && <p className="set-hint">No seats listed yet.</p>}
      </div>

      <h3>Overrides</h3>
      <div className="set-card">
        {PIPELINE.map((s) => {
          const options = serving(list, s.role);
          const chosen = options.find((c) => c.id === voice[s.role]);
          return (
            <Row key={s.role} icon={chosen && (chosen.provider === 'anthropic' || chosen.provider === 'openai' || chosen.provider === 'google') ? <ProviderMark provider={chosen.provider} /> : <s.icon width={18} height={18} />}
              title={s.title} desc={chosen ? `On ${chosen.label}. These hours stay off the allowance.` : options.length ? 'Quorum managed. Counts against the included hours.' : 'Quorum managed. Add a connector with this role to move it.'}>
              <select className="set-select" aria-label={`${s.title} provider`} value={voice[s.role] ?? ''} disabled={!canManage || !options.length} onChange={(e) => choose(s.role, e.target.value)}>
                <option value="">Quorum managed (included)</option>
                {options.map((c) => <option key={c.id} value={c.id}>{c.label} · {PROVIDERS[c.provider].name}</option>)}
              </select>
            </Row>
          );
        })}
      </div>
      {error && <p className="set-error">{error}</p>}
      <p className="set-note">Use your own providers here to keep every seat at the base price with no hour packs.</p>
    </div>
  );
}
