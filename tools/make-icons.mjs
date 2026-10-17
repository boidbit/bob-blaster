// Renders the app icon + splash source PNGs into ./assets (input for `npm run assets` = capacitor-assets).
import {chromium} from 'playwright-core';
import fs from 'node:fs';
const CHROME=process.env.CHROME_PATH||undefined;

const defs=`<defs>
  <radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#3B2466"/><stop offset="1" stop-color="#15101F"/></radialGradient>
  <radialGradient id="blob" cx="38%" cy="30%" r="80%"><stop offset="0" stop-color="#8CF5A8"/><stop offset=".55" stop-color="#3CCB6C"/><stop offset="1" stop-color="#1E9E4F"/></radialGradient>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
</defs>`;
// the character art, drawn in a 1024 box, kept inside the central ~640px so adaptive-icon masks never crop it
const art=`
  <g>
    <ellipse cx="512" cy="540" rx="250" ry="235" fill="#3CCB6C" opacity=".45" filter="url(#glow)"/>
    <!-- shots -->
    <g fill="#FFD23F" stroke="#1A0A2A" stroke-width="10">
      <rect x="486" y="170" width="52" height="96" rx="26"/>
      <rect x="486" y="82" width="52" height="64" rx="26" opacity=".75"/>
    </g>
    <!-- blob body -->
    <path d="M512 280 C690 280 786 410 786 560 C786 706 676 790 512 790 C348 790 238 706 238 560 C238 410 334 280 512 280 Z" fill="url(#blob)" stroke="#1A0A2A" stroke-width="22" stroke-linejoin="round"/>
    <ellipse cx="400" cy="400" rx="64" ry="36" fill="#fff" opacity=".55" transform="rotate(-28 400 400)"/>
    <!-- eyes -->
    <g stroke="#1A0A2A" stroke-width="16">
      <ellipse cx="420" cy="560" rx="58" ry="70" fill="#fff"/>
      <ellipse cx="604" cy="560" rx="58" ry="70" fill="#fff"/>
    </g>
    <circle cx="436" cy="574" r="30" fill="#1A0A2A"/><circle cx="620" cy="574" r="30" fill="#1A0A2A"/>
    <circle cx="446" cy="562" r="10" fill="#fff"/><circle cx="630" cy="562" r="10" fill="#fff"/>
    <!-- mouth -->
    <path d="M440 676 Q512 726 584 676" fill="none" stroke="#1A0A2A" stroke-width="18" stroke-linecap="round"/>
  </g>`;

const svgs={
 'icon-only':`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs}<rect width="1024" height="1024" fill="url(#bg)"/>${art}</svg>`,
 'icon-foreground':`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs}${art}</svg>`,
 'icon-background':`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs}<rect width="1024" height="1024" fill="url(#bg)"/></svg>`,
};
// splash: 2732x2732 canvas, art centred and small
const splash=(dark)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2732 2732">${defs}<rect width="2732" height="2732" fill="#15101F"/><g transform="translate(866 866) scale(1)">${art}</g></svg>`;
svgs['splash']=splash(false);svgs['splash-dark']=splash(true);

const b=await chromium.launch({executablePath:CHROME});
for(const [name,svg] of Object.entries(svgs)){
  const size=name.startsWith('splash')?2732:1024;
  const p=await b.newPage({viewport:{width:size,height:size}});
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ',`<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({path:`assets/${name}.png`,omitBackground:true,clip:{x:0,y:0,width:size,height:size}});
  await p.close();
}
await b.close();
fs.writeFileSync('assets/README.md','Source art for the app icon and splash. Regenerate with `node tools/make-icons.mjs`, then `npm run assets`.\n');
console.log('assets written');
