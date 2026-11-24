import { ImageResponse } from 'next/og';
import { PlateMark } from '@/components/brand/PlateMark';

export async function GET(req: Request, ctx: { params: Promise<{ size: string }> }) {
  const { size } = await ctx.params;
  const px = Math.min(1024, Math.max(48, Number(size) || 192));
  const maskable = new URL(req.url).searchParams.has('maskable');
  return new ImageResponse(<PlateMark size={px} padding={maskable ? 0.2 : 0.1} />, {
    width: px,
    height: px,
    headers: { 'Cache-Control': 'public, max-age=86400, immutable' },
  });
}
