import { ImageResponse } from 'next/og';
import { PlateMark } from '@/components/brand/PlateMark';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(<PlateMark size={64} padding={0.06} />, size);
}
