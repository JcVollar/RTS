# Unit sprite art

Drop pixel-art frames here, one folder per unit — e.g. `assets/soldier/`.

The renderer (`js/sprites.js`) maps each unit type to frames via `SPRITE_DEFS`.
For the CC0 **PixVoxel** set the filenames look roughly like:

    blue_Infantry_0_0_0.png            <color>_<Unit>_<Size>_<dir>_<frame>.png
    blue_Infantry_0_0_attack_0.png     ... attack frames carry a tag

## Hooking up a unit
1. Put its frames in `assets/<name>/` (only the palette + directions you use —
   you do NOT need the whole 200 MB archive, just the soldier frames you want).
2. Edit `SPRITE_DEFS.<type>` in `js/sprites.js`:
   - `folder`, `unit`, `variant`, `colors` (per team), `dirs`, and the `anims`
     (`idle` / `walk` / `fire`) frame counts + filename `tag`.
   - Make `spriteFilePath()` match your ACTUAL filenames.
3. Reload and tune `scale`, `anchorY`, `offX/offY`, and `dirOffset` until the
   unit stands on its tile and faces the right way.

## Notes
- Missing / not-yet-added art automatically falls back to the old procedural
  bodies, so the game keeps running while you add art one unit at a time.
- Frames are drawn with smoothing off so pixels stay crisp.
- Once you've extracted the soldier frames, paste me a few real filenames and
  I'll finalize `spriteFilePath()` and the frame counts for you.
