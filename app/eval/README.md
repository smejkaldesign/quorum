# Transcription eval

Dev-only harness that scores transcription engines on a local corpus. Plain Node ESM, no new app dependencies.
Audio and results never get committed; `corpus/*/` and `results/` are gitignored.

## Corpus layout

One folder per item under `corpus/`:

```
corpus/<item>/
  me.wav  them.wav     16 kHz mono PCM16, one per channel on a shared timeline
  audio.wav            or one mixed file instead of the pair (cloud engines diarize it)
  reference.json       { turns: [{ speaker: "me" | "them" | name, text }], entities: ["Anneliese Vogt", "$42,000"] }
  meta.json            { source, consent, date, duration }
```

`entities` are names, product terms, money and dates that must survive transcription. They also go to each engine as
vocabulary (Apple contextual strings, AssemblyAI word boost, Deepgram keyterms) unless `--no-terms` is passed.

Real meeting audio is added locally and only with the consent of everyone recorded. `make-synthetic.mjs` builds eight
fictional exchanges with macOS `say` (Samantha for me, Daniel for them) so the plumbing has exact ground truth.

## Running

```
cd helper && swift build                      # the Apple engine drives helper/.build/debug/QuorumHelper
cd app
node eval/make-synthetic.mjs                  # or: npm run eval:synthetic
npm run eval -- --engines apple               # table per engine, results/<date>-<engine>.json
npm run eval -- --engines apple,assemblyai,deepgram --yes
```

Flags: `--engines a,b`, `--corpus <dir>`, `--items name,name`, `--clean` (hypotheses through `app/clean.js` when it
exists; fillers then drop from the reference too), `--no-terms`, `--yes` (cloud spend over 30 audio minutes),
`--fail-over 0.25` (exit 1 above that corpus WER), `--helper <path>`.

Cloud engines need Keychain items for account `quorum`: services `assemblyai-quorum` and `deepgram-quorum`. Keys are
read in-process by `security find-generic-password` and never printed. Each cloud run prints its estimated cost first
($0.15/h AssemblyAI, $0.46/h Deepgram) and refuses above 30 audio minutes without `--yes`. Two channel files count twice.

## Metrics

All text goes through `normalize.mjs` first (rules documented inline). `wer.mjs` reports:

- WER: word edit distance over the whole item in turn order, summed across items before dividing.
- Entity error rate: fraction of `entities` whose normalized form is missing from the hypothesis.
- cpWER: words concatenated per speaker, hypothesis speakers mapped to reference speakers by the best permutation.
- Median seconds per item: file turnaround, not streaming latency. Streaming latency needs live capture.

`summary-check.mjs` is a stub for note faithfulness: given a note (`sections[].bullets[].text` with `refs` to turn ids)
and a turn list, it reports the fraction of bullets whose refs exist and whose key numbers and names appear in the
referenced turns.

## CI

`npm run eval:ci` rebuilds the synthetic corpus and runs the Apple engine, exiting non-zero when corpus WER is over
0.25. It needs a macOS runner with the helper built; the workflow should gate it on `runner.os == 'macOS'`. Cloud
engines never run in CI.
