import { describe, expect, it } from 'vitest';
import { BRAND_LOGOS, brandSrc } from '../src/brandLogos.ts';

const svgOf = (id) => decodeURIComponent(brandSrc(BRAND_LOGOS[id]).replace('data:image/svg+xml,', ''));

describe('brand marks on the dark tile', () => {
  it('Slack draws in its four brand colors, never all white', () => {
    const svg = svgOf('slack');
    for (const c of ['#E01E5A', '#36C5F0', '#2EB67D', '#ECB22E']) expect(svg).toContain(`fill="${c}"`);
    expect(svg.match(/<path /g)).toHaveLength(4);
    expect(svg).not.toContain('fill="#FFFFFF"');
  });
  it('the one-color marks still draw one path in their fill', () => {
    for (const id of ['notion', 'github']) {
      expect(svgOf(id).match(/<path /g)).toHaveLength(1);
      expect(svgOf(id)).toContain('fill="#FFFFFF"');
    }
  });
  it('Google Drive, Calendar, Meet, Gmail and Figma draw in their official colors', () => {
    const colors = {
      'google-drive': ['#0066DA', '#00AC47', '#EA4335', '#00832D', '#2684FC', '#FFBA00'],
      'google-calendar': ['#4285F4', '#FBBC04', '#34A853', '#1967D2', '#EA4335', '#188038'],
      'google-meet': ['#EA4335', '#FFBA00', '#00AC47', '#2684FC', '#00832D', '#0066DA'],
      gmail: ['#4285F4', '#34A853', '#EA4335', '#FBBC04', '#C5221F'],
      figma: ['#1ABCFE', '#0ACF83', '#FF7262', '#F24E1E', '#A259FF'],
    };
    for (const [id, list] of Object.entries(colors)) for (const c of list) expect(svgOf(id), `${id} ${c}`).toContain(`fill="${c}"`);
  });
  it('a mark drawn on its own box is scaled into the 24 unit area and centered', () => {
    // Figma is 38 by 57: scaled by 24/57, it is 16 wide, so it starts 4 in
    expect(svgOf('figma')).toContain('<g transform="translate(4 0) scale(0.42105)">');
    expect(svgOf('gmail')).toMatch(/translate\(0 2\.95\d*\) scale\(0\.09375\)/);
    expect(svgOf('slack')).not.toContain('<g transform');
  });
});
