/**
 * Stealth runtime helpers — owned-site inspection only (gated at API layer).
 * Reduces common Playwright/Chromium automation signals so managed challenges
 * (Cloudflare JS / Turnstile checkbox) on the caller's own site can complete.
 * Not a third-party captcha farm or recaptcha/hcaptcha puzzle solver.
 */

/** Fallback major when the launched browser version cannot be parsed (Playwright 1.51 ≈ 134). */
export const STEALTH_FALLBACK_CHROME_MAJOR = 134;

export const STEALTH_PROFILE = 'chromium-stealth-init-v2';

export function chromeMajorFromBrowserVersion(version: string | undefined): number {
  if (!version) return STEALTH_FALLBACK_CHROME_MAJOR;
  const match = version.match(/(\d+)\.\d+\.\d+/);
  const major = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(major) && major >= 100 ? major : STEALTH_FALLBACK_CHROME_MAJOR;
}

export function buildStealthUserAgent(major: number): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function buildSecChUa(major: number): string {
  return `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not_A Brand";v="24"`;
}

export const STEALTH_DEFAULT_USER_AGENT = buildStealthUserAgent(STEALTH_FALLBACK_CHROME_MAJOR);

export function stealthRuntimeEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SCOUT_STEALTH_RUNTIME_ENABLED?.trim().toLowerCase();
  if (!raw) return false;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function getStealthLaunchOptions(baseArgs: string[]): {
  channel: 'chromium';
  ignoreDefaultArgs: string[];
  args: string[];
} {
  return {
    // Full Chromium, not chrome-headless-shell (Playwright 1.49+ default).
    channel: 'chromium',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      ...baseArgs,
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--metrics-recording-only',
      '--password-store=basic',
      '--use-mock-keychain',
    ],
  };
}

/** Init script injected into every stealth context before any navigation. */
export function buildStealthInitScript(): string {
  const stealthInit = function () {
    const patch = (obj: object, key: string, value: unknown) => {
      try {
        Object.defineProperty(obj, key, { get: () => value, configurable: true });
      } catch {
        // ignore
      }
    };

    try {
      patch(Navigator.prototype, 'webdriver', undefined);
      patch(navigator, 'webdriver', undefined);
    } catch {
      // ignore
    }

    try {
      patch(navigator, 'vendor', 'Google Inc.');
      patch(navigator, 'platform', 'Linux x86_64');
      patch(navigator, 'maxTouchPoints', 0);
      patch(navigator, 'hardwareConcurrency', 8);
      patch(navigator, 'deviceMemory', 8);
      patch(navigator, 'language', 'en-US');
      patch(navigator, 'languages', Object.freeze(['en-US', 'en']));
    } catch {
      // ignore
    }

    try {
      const chrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
        runtime: {
          OnInstalledReason: {
            CHROME_UPDATE: 'chrome_update',
            INSTALL: 'install',
            SHARED_MODULE_UPDATE: 'shared_module_update',
            UPDATE: 'update',
          },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOs: {
            ANDROID: 'android',
            CROS: 'cros',
            LINUX: 'linux',
            MAC: 'mac',
            OPENBSD: 'openbsd',
            WIN: 'win',
          },
          RequestUpdateCheckStatus: {
            NO_UPDATE: 'no_update',
            THROTTLED: 'throttled',
            UPDATE_AVAILABLE: 'update_available',
          },
          connect: function () {},
          sendMessage: function () {},
          id: undefined,
        },
        csi: function () {
          return {};
        },
        loadTimes: function () {
          return {};
        },
      };
      (window as unknown as { chrome: typeof chrome }).chrome = chrome;
    } catch {
      // ignore
    }

    try {
      const pluginData = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];
      const plugins = pluginData.map((p) => p);
      patch(navigator, 'plugins', plugins);
      patch(
        navigator,
        'mimeTypes',
        pluginData.map(() => ({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' })),
      );
    } catch {
      // ignore
    }

    try {
      const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission } as unknown as PermissionStatus);
        }
        return originalQuery(parameters);
      };
    } catch {
      // ignore
    }

    const spoofUnmasked = (proto: { getParameter: (p: number) => unknown }) => {
      const original = proto.getParameter;
      proto.getParameter = function (parameter: number) {
        if (parameter === 37445) return 'Google Inc. (Intel)';
        if (parameter === 37446) return 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)';
        return original.call(this, parameter);
      };
    };
    try {
      spoofUnmasked(WebGLRenderingContext.prototype);
    } catch {
      // ignore
    }
    try {
      spoofUnmasked(WebGL2RenderingContext.prototype);
    } catch {
      // ignore
    }

    try {
      if (window.outerWidth === 0) patch(window, 'outerWidth', window.innerWidth);
      if (window.outerHeight === 0) patch(window, 'outerHeight', window.innerHeight);
    } catch {
      // ignore
    }
  };

  return `(${stealthInit.toString()})();`;
}

export function applyStealthDefaults(options: {
  userAgent?: string;
  locale?: string;
  extraHTTPHeaders?: Record<string, string>;
  chromeMajor?: number;
}): {
  userAgent: string;
  locale: string;
  extraHTTPHeaders: Record<string, string>;
} {
  const major = options.chromeMajor ?? STEALTH_FALLBACK_CHROME_MAJOR;
  const locale = options.locale ?? 'en-US';
  const headers: Record<string, string> = { ...(options.extraHTTPHeaders ?? {}) };
  if (!headers['Accept-Language']) {
    headers['Accept-Language'] = `${locale},en;q=0.9`;
  }
  if (!headers['Sec-CH-UA']) {
    headers['Sec-CH-UA'] = buildSecChUa(major);
  }
  if (!headers['Sec-CH-UA-Mobile']) headers['Sec-CH-UA-Mobile'] = '?0';
  if (!headers['Sec-CH-UA-Platform']) headers['Sec-CH-UA-Platform'] = '"Linux"';
  return {
    userAgent: options.userAgent ?? buildStealthUserAgent(major),
    locale,
    extraHTTPHeaders: headers,
  };
}

export function getStealthRuntimeStatus(env: NodeJS.ProcessEnv = process.env) {
  const enabled = stealthRuntimeEnabledFromEnv(env);
  return {
    enabled,
    available: enabled,
    profile: STEALTH_PROFILE,
    notes: enabled
      ? 'Separate full-Chromium pool, automation flags stripped, fingerprint init script, client hints matched to browser version'
      : 'Set SCOUT_STEALTH_RUNTIME_ENABLED=true to enable',
  };
}
