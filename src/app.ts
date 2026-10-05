import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { requireScoutApiKey, scoutIngressRateLimit, scoutRateLimit } from './auth/middleware';
import { scoutDemoKeyGuard } from './auth/demoGuard';
import { scoutConfig } from './config';
import { scoutCreditsMiddleware } from './credits/middleware';
import { mountScoutSwagger } from './openapi/mount';
import { ensureLicenseOnStartup, getLicenseState } from './lib/licenseClient';
import { applyWorkerLimitFromLicense } from './lib/workerLimits';
import { getBrowserPoolStats } from './browser/concurrency';
import { getStealthRuntimeStatus } from './browser/pool';
import { scoutLicenseGuard } from './middleware/licenseGuard';
import { v1Router } from './routes/v1';

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

mountScoutSwagger(app);

app.get('/health', (_req, res) => {
  const license = getLicenseState();
  const browserPool = getBrowserPoolStats();
  res.json({
    ok: true,
    service: 'macro-scout',
    version: '0.7.0',
    ...(process.env.NODE_ENV === 'production'
      ? {}
      : {
          keysConfigured: scoutConfig.keys.length,
          hasInternalKey: scoutConfig.keys.some((k) => k.tier === 'internal'),
        }),
    deploymentMode: scoutConfig.deploymentMode,
    requireDomainVerify: scoutConfig.requireDomainVerify,
    licenseTier: scoutConfig.licenseTier,
    licenseWorkers: scoutConfig.licenseLimits?.maxWorkers ?? null,
    browser_pool: browserPool,
    stealth_runtime: getStealthRuntimeStatus(),
    license: scoutConfig.deploymentMode === 'self_hosted'
      ? {
          valid: license.valid,
          tier: license.tier,
          max_workers: license.maxWorkers,
          instance_id: license.instanceId,
          last_check_at: license.lastCheckAt ? new Date(license.lastCheckAt).toISOString() : null,
          last_error: license.lastError,
        }
      : undefined,
    securityPolicy: {
      requireDomainVerification: scoutConfig.securityPolicy.requireDomainVerification,
      allowPrivateNetworks: scoutConfig.securityPolicy.allowPrivateNetworks,
      allowedDomains: scoutConfig.securityPolicy.allowedDomains.length,
      blockedDomains: scoutConfig.securityPolicy.blockedDomains.length,
    },
    webhookSecretConfigured: Boolean(scoutConfig.webhookSecret),
    resultCacheTtlSeconds: scoutConfig.resultCacheTtlSeconds,
    jobTtlSeconds: scoutConfig.jobTtlSeconds,
  });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'Macro Scout',
    description: 'Web Verification / Site Inspection API',
    docs: 'https://docs.macrocontent.dev/scout/',
    swagger: '/docs',
    openapi: '/openapi.json',
    auth: 'Authorization: Bearer <api-key> or X-Scout-Key: <api-key>',
    version: '0.7.0',
    principles: {
      raw_data_only: true,
      no_content_archive: true,
      dogfood_same_public_api: true,
    },
    endpoints: {
      health: 'GET /health',
      usage: 'GET /v1/usage',
      devices: 'GET /v1/devices',
      dns: 'POST /v1/dns',
      robots: 'POST /v1/robots',
      crawl: 'POST /v1/crawl',
      templates: 'GET|POST /v1/templates',
      domains: 'GET|POST /v1/domains',
      domainVerify: 'POST /v1/domains/:id/verify',
      screenshot: 'POST /v1/screenshot',
      screenshotJson: 'POST /v1/screenshot/json',
      screenshotViewports: 'POST /v1/screenshot/viewports',
      screenshotDiff: 'POST /v1/screenshot/diff',
      visibility: 'POST /v1/checks/visibility',
      assert: 'POST /v1/assert',
      security: 'POST /v1/checks/security',
      a11y: 'POST /v1/checks/a11y',
      cookies: 'POST /v1/checks/cookies',
      console: 'POST /v1/checks/console',
      network: 'POST /v1/checks/network',
      assets: 'POST /v1/checks/assets',
      jsonLd: 'POST /v1/checks/json-ld',
      canonical: 'POST /v1/checks/canonical',
      sitemap: 'POST /v1/checks/sitemap',
      images: 'POST /v1/checks/images',
      resources: 'POST /v1/checks/resources',
      a11ySnapshot: 'POST /v1/checks/a11y-snapshot',
      forms: 'POST /v1/checks/forms',
      opengraph: 'POST /v1/checks/opengraph',
      links: 'POST /v1/checks/links',
      diffDom: 'POST /v1/diff/dom',
      diffHeaders: 'POST /v1/diff/headers',
      tech: 'POST /v1/checks/tech',
      extract: 'POST /v1/extract',
      journey: 'POST /v1/journey',
      inspect: 'POST /v1/inspect',
      files: 'POST /v1/files',
      pdfExtract: 'POST /v1/pdf/extract',
      performance: 'POST /v1/performance',
      sandbox: 'POST /v1/sandbox',
      jobs: 'POST /v1/jobs',
      jobStatus: 'GET /v1/jobs/:id',
    },
    errors: {
      shape: '{ error, code, retryable, details?, captcha_detected? }',
      docs: 'https://docs.macrocontent.dev/scout/errors/',
    },
    webhooks: {
      signature_header: 'X-Scout-Signature: sha256=<hmac>',
      timestamp_header: 'X-Scout-Timestamp',
      secret_env: 'SCOUT_WEBHOOK_SECRET or per-key webhookSecret or job webhook_secret',
    },
    domain_verify: {
      required_for: [
        'journey with interact/evaluate/cookies',
        'http_auth / client_certificates (Basic Auth / mTLS)',
        'solve_captcha',
        'stealth',
      ],
      not_required_for: [
        'screenshot',
        'extract',
        'inspect',
        'performance',
        'visibility',
        'dns',
        'crawl',
        'read-only journeys',
      ],
      internal_key_bypasses: true,
      self_hosted_skips_verify: scoutConfig.deploymentMode === 'self_hosted',
      require_domain_verify: scoutConfig.requireDomainVerify,
      security_policy: scoutConfig.deploymentMode === 'self_hosted'
        ? {
            allow_private_networks: scoutConfig.securityPolicy.allowPrivateNetworks,
            allowed_domains: scoutConfig.securityPolicy.allowedDomains,
            blocked_domains: scoutConfig.securityPolicy.blockedDomains,
          }
        : undefined,
      reverify_days: scoutConfig.domainReverifyDays,
    },
  });
});

app.use(
  '/v1',
  scoutIngressRateLimit(),
  scoutLicenseGuard(),
  requireScoutApiKey,
  scoutDemoKeyGuard,
  scoutCreditsMiddleware(),
  scoutRateLimit(),
  v1Router,
);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[scout] unhandled error', err);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    retryable: true,
  });
});

if (!scoutConfig.keys.length) {
  console.warn(
    '[scout] WARNING: no API keys configured. Set SCOUT_INTERNAL_API_KEY (and optionally SCOUT_API_KEYS). All /v1 calls will 401.',
  );
}

void ensureLicenseOnStartup().then(() => {
  applyWorkerLimitFromLicense();
  app.listen(scoutConfig.port, () => {
    console.log(`[scout] listening on http://localhost:${scoutConfig.port}`);
    console.log(`[scout] swagger UI http://localhost:${scoutConfig.port}/docs`);
  });
});

export default app;
