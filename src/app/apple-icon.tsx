import { ImageResponse } from 'next/og';
import { PlateMark } from '@/components/brand/PlateMark';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<PlateMark size={180} padding={0.12} />, size);
}
