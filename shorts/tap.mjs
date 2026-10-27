// The recording tap for the shorts: a few lines patched into a temporary copy of the game (never into www/), so the
// recorder sees what happens as it happens (pops, hearts lost, the cannon blowing up, the level cleared, every shot)
// and can draw a frame on demand. tools/harness.mjs then adds its own debug hook (window.__bb) on top of this copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the end of the game script: the same spot tools/harness.mjs patches. The tap goes just before it, so the harness still finds it.
export const NEEDLE = "showOverlay('menu');hud();requestAnimationFrame(loop);\n})();";

// Wraps game functions by name (they are function declarations, so the game's own calls go through the wrappers).
// Behaviour is unchanged: each wrapper only writes a note and calls the original.
const TAP = `
window.__tap={ev:[],draw:d=>draw(d),get state(){return state},get inv(){return inv},get pending(){return !!pending},
  fresh(){fireT=0;time=0;shake=0;gridT=0;comboPop=0;cannon.recoil=0;cannon.flash=0;}};   // as a fresh page load, so a seed replays a take
{const _pop=pop;pop=function(b){_pop(b);window.__tap.ev.push({k:'pop',s:b.s,hp:b.max,x:b.x,y:b.y,c:combo,last:!blobs.length&&!queue.length&&cannon.alive});};}
{const _hurt=hurt;hurt=function(b){window.__tap.ev.push({k:'hurt',lives:lives-1,s:b.s,x:cannon.x});_hurt(b);};}
{const _die=die;die=function(){window.__tap.ev.push({k:'die',x:cannon.x});_die();};}
{const _clear=levelClear;levelClear=function(){window.__tap.ev.push({k:'clear',lives});_clear();};}
{const _pew=sfx.pew;sfx.pew=function(){window.__tap.ev.push({k:'shot'});_pew();};}
`;

export function patchGame(src) {
  src = src.replace(/\r\n/g, '\n');   // a Windows checkout has CRLF line ends
  if (!src.includes(NEEDLE)) throw new Error('shorts: could not find the end of the game script to patch (www/index.html changed?)');
  return src.replace(NEEDLE, TAP + NEEDLE);
}

// a patched copy in a temporary folder; returns its path (for GAME_FILE, which tools/harness.mjs reads)
export function writePatchedGame() {
  const src = fs.readFileSync(path.join(ROOT, 'www/index.html'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-shorts-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, patchGame(src));
  return file;
}
