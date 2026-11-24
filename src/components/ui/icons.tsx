import type { ReactNode, SVGProps } from 'react';

// Line icons for the chat composer (24×24, currentColor). The rest of the app keeps its mono glyphs.
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 22, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const CloseIcon = (p: IconProps) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const ArrowUpIcon = (p: IconProps) => <Svg {...p} strokeWidth={2.2}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>;
export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);
export const StopIcon = ({ size = 14, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" {...rest}><rect x="1" y="1" width="12" height="12" rx="2.5" fill="currentColor" /></svg>
);
export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.3-2h6l1.3 2h1.2A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
    <circle cx="12" cy="12.5" r="3.4" />
  </Svg>
);
export const PhotoIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <circle cx="9" cy="9.5" r="1.6" />
    <path d="M20.5 15.5l-4.5-4.5-8.5 8.5" />
  </Svg>
);
export const SkillsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 8.8l5-.7z" />
  </Svg>
);
export const GaugeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 16.5a8 8 0 1 1 15 0" />
    <path d="M12 13.5l3.5-4" />
    <circle cx="12" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);
export const CheckIcon = (p: IconProps) => <Svg {...p} strokeWidth={2}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const MenuIcon = (p: IconProps) => <Svg {...p}><path d="M4 8h12M4 15h8" /></Svg>;
export const ChevronLeftIcon = (p: IconProps) => <Svg {...p}><path d="M15 5l-7 7 7 7" /></Svg>;
export const RetryIcon = (p: IconProps) => <Svg {...p}><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4.5v4h4" /></Svg>;
