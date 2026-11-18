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
});
