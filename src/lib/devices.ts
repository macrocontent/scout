import type { WithPageOptions } from '../browser/pool';

export type DevicePreset = {
  name: string;
  userAgent: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
};

/**
 * Chromium-oriented subset inspired by Playwright devices.
 * Names are stable API identifiers.
 */
export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'iPhone SE': {
    name: 'iPhone SE',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 13': {
    name: 'iPhone 13',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 14 Pro Max': {
    name: 'iPhone 14 Pro Max',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPad Pro': {
    name: 'iPad Pro',
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 1024, height: 1366 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  'Pixel 7': {
    name: 'Pixel 7',
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  },
  'Pixel 5': {
    name: 'Pixel 5',
    userAgent:
      'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
  },
  'Galaxy S9+': {
    name: 'Galaxy S9+',
    userAgent:
      'Mozilla/5.0 (Linux; Android 8.0.0; SM-G965U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewport: { width: 320, height: 658 },
    deviceScaleFactor: 4.5,
    isMobile: true,
    hasTouch: true,
  },
  Desktop: {
    name: 'Desktop',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  'Desktop Chrome HiDPI': {
    name: 'Desktop Chrome HiDPI',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
};

export function listDevicePresetNames(): string[] {
  return Object.keys(DEVICE_PRESETS);
}

export function resolveDevicePreset(name: string | undefined | null): DevicePreset | null {
  if (!name?.trim()) return null;
  const exact = DEVICE_PRESETS[name];
  if (exact) return exact;
  const lower = name.trim().toLowerCase();
  const hit = Object.entries(DEVICE_PRESETS).find(([k]) => k.toLowerCase() === lower);
  return hit ? hit[1] : null;
}

export function deviceToPageOptions(device: DevicePreset): Partial<WithPageOptions> & {
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
} {
  return {
    width: device.viewport.width,
    height: device.viewport.height,
    userAgent: device.userAgent,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
  };
}
