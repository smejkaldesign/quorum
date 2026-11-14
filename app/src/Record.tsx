import { Toggle } from './controls';
import { IconMic, IconScreen } from './icons';
import { canStart, type RecordChoice } from './noteRecord';

// the Record popover, in the header and in the note view: Transcription (on by default) and Screen (off by default).
// Screen shows only when the screen-context flag and its Preferences setting are on; callers skip the popover when it
// is not offered, since Transcription is then the only choice
export function RecordMenu({ choice, onChoice, onStart }: { choice: RecordChoice; onChoice: (c: RecordChoice) => void; onStart: (c: RecordChoice) => void }) {
  return (
    <div className="menu record-menu" role="dialog" aria-label="Record" onClick={(e) => e.stopPropagation()}>
      <div className="record-opt">
        <IconMic width={18} height={18} />
        <span><strong>Transcription</strong><em>Your voice and your Mac's sound, written into the note</em></span>
        <Toggle on={choice.audio} onChange={(audio) => onChoice({ ...choice, audio })} />
      </div>
      <div className="record-opt">
        <IconScreen width={18} height={18} />
        <span><strong>Screen</strong><em>The front window's text, read every minute and added to the note</em></span>
        <Toggle on={choice.screen} onChange={(screen) => onChoice({ ...choice, screen })} />
      </div>
      <button className="pill primary record-go" disabled={!canStart(choice)} onClick={() => onStart(choice)}>Start recording</button>
    </div>
  );
}
