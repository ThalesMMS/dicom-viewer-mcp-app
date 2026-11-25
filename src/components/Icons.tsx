/**
 * @file Inline SVG icons (no external assets). Decorative: the buttons that
 * use them carry the accessible label.
 */
import type { ReactNode } from "react";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconContrast = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
  </Svg>
);

export const IconPan = () => (
  <Svg>
    <path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3" />
  </Svg>
);

export const IconZoomTool = () => (
  <Svg>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M20 20l-4.8-4.8M10.5 7.5v6M7.5 10.5h6" />
  </Svg>
);

export const IconPlus = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconMinus = () => (
  <Svg>
    <path d="M5 12h14" />
  </Svg>
);

export const IconReset = () => (
  <Svg>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Svg>
);

export const IconInvert = () => (
  <Svg>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 21L21 3V21z" fill="currentColor" />
  </Svg>
);

export const IconOverlay = () => (
  <Svg>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M7 7h4M7 17h4M15 7h2M15 17h2" />
  </Svg>
);

export const IconFullscreen = () => (
  <Svg>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);

export const IconExitFullscreen = () => (
  <Svg>
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </Svg>
);

export const IconPrev = () => (
  <Svg>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);

export const IconNext = () => (
  <Svg>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export const IconWarning = () => (
  <Svg>
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v4M12 17.5v.5" />
  </Svg>
);
