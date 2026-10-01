---
name: music-gen-instrumental
description: Compose instrumental music with the current agent, then validate and render a local score to MIDI and WAV using the music-gen-instrumental package. Use when the user asks for a song, theme, soundtrack, loop, or instrumental audio file in Claude Code or Codex.
---

# Create instrumental music locally

Use the current agent to compose the score. The `music-gen-instrumental render` command validates and renders it locally; it does not call an AI model or require an API key. In Claude Code this uses the signed-in Claude session for composition. In Codex it uses the current Codex model. Do not pass subscription credentials to the package or call `generateMusic` unless the user asks for the API workflow.

The skill file does not install the renderer. If `music-gen-instrumental` is not on `PATH`, use Node.js 20+, npm, and Git to run it from the public GitHub repository without adding a dependency to the user's project:

```sh
npm exec --yes --package=github:Jellypod-Inc/music-gen-instrumental -- music-gen-instrumental render score.json --out ./music-output
```

The first invocation fetches the package from GitHub and stores it in npm's cache. Use the same command for subsequent renders, replacing the score and output paths as needed.

1. Write a compact score JSON file in the user's workspace. Honor the prompt's style, melody, arrangement, length, and instrument requests. Choose the tracks needed for the music; there is no fixed track list.
2. Run `music-gen-instrumental render <score.json> --out <output-directory>` if installed, or use the GitHub-backed `npm exec` command above. For a user-supplied SoundFont and locally installed FluidSynth, add `--soundfont <bank.sf2>`. The default renderer needs no external assets.
3. If validation fails, fix the score and render again. Review the returned duration, note count, track count, and file paths. Listen or inspect the audio if the host has an audio preview. Report what was generated, any uncertainty about musical quality or fidelity, and the saved WAV and MIDI paths.

The compact score format is:

```json
{
  "title": "Morning Light",
  "bpm": 120,
  "meter": "4/4",
  "bars": 8,
  "tracks": [
    {
      "id": "melody",
      "sound": "soft-piano",
      "role": "main melody",
      "patterns": [{"id": "A", "notes": ["0,60,1,88", "1,64,1,82", "2,67,2,85"]}],
      "play": ["A,0,0", "A,2,0", "A,4,2", "A,6,0"]
    }
  ]
}
```

Each note is `beatOffset,MIDIpitch,durationBeats,velocity`. Each placement is `patternId,zeroBasedStartBar,transposeSemitones`. Beats are quarter-note beats even in meters such as 3/8. Duration is `bars × beatsPerBar × 60 / bpm`; choose bars and BPM for the requested length. Place notes so they end within the score. A pattern may span multiple bars. Reuse and vary patterns to build sections instead of copying an unchanged phrase for the whole piece.

Available `sound` values: `soft-piano`, `warm-pad`, `glass-lead`, `round-bass`, `pluck`, `kick`, `snare`, `hat`, `pulse-lead`, `pulse-bass`, `chip-arp`, and `custom`. For `custom`, include a `voice` with `wave` (`sine`, `triangle`, `saw`, `square`, or `noise`); optional voice fields include `dutyCycle`, `gain`, `attack`, `release`, `lowpassHz`, `pan`, `program`, and `percussion`. `program` is a zero-based General MIDI instrument hint used by SoundFont rendering. Percussion placements cannot transpose. The renderer verifies musical score limits and writes `composition.wav`, `composition.mid`, `project.json`, and `summary.json`.

When a user asks for a faithful piece, state whether the result was checked against a score. For a loop request, compose the ending and opening to connect; a clean sample boundary alone does not establish a seamless musical loop.
