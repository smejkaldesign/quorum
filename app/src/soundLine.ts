// a sound line in a transcript: music between notes, anything else in brackets. Its own module so the note reader
// can use it without loading the recording page
export const soundLine = (label: string) => (label === 'Music' ? `♪ ${label} ♪` : `[${label}]`);
