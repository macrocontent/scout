/**
 * Macro Scout OpenAPI 3.0 — served at GET /openapi.json and Swagger UI /docs
 */

const browseProps = {
  respect_robots: { type: 'boolean', description: 'Default true — honor robots.txt' },
  wait_for_selector: { type: 'string' },
  wait_for_selector_timeout_ms: { type: 'integer', minimum: 100, maximum: 120000 },
  wait_for_selector_required: { type: 'boolean', default: true },
  dismiss_cookie_banner: {
    type: 'boolean',
    description:
      'Best-effort click of known cookie CMP accept buttons (fixed allowlist). No domain verify required. Not free interact — custom selectors are rejected.',
  },
  device: { type: 'string', description: 'Preset from GET /v1/devices' },
  detect_captcha: { type: 'boolean' },
  solve_captcha: {
    type: 'boolean',
    description:
      'Best-effort owned-site challenge handling: wait for Cloudflare JS / managed Turnstile to auto-pass, then click visible checkbox widgets. Requires domain verify (cloud). Self-hosted skips verify. Pair with stealth: true. Does not solve image/audio puzzles. Unverified third-party URLs return 403.',
  },
  stealth: {
    type: 'boolean',
    description:
      'Use dedicated stealth runtime (profile chromium-stealth-init-v2: full Chromium not headless-shell, automation flags stripped, fingerprint init script, client hints matched to the browser). Pair with solve_captcha on owned sites so Cloudflare JS / Turnstile checkbox can complete. Adds 2.0x credit multiplier. Cloud: verified domain + Basic/Pro/Internal. Self-hosted: allowed without DNS verify. JSON responses include browser_runtime; screenshots use X-Scout-Browser-Runtime.',
  },
  capture_xhr: {
    type: 'string',
    description: 'Glob or substring matching XHR/fetch URLs to capture (bodies, max 20). Example: */api/*',
  },
  fetch_mode: {
    type: 'string',
    enum: ['browser', 'http'],
    description: 'http disables JavaScript (static document). Default browser.',
  },
  color_scheme: { type: 'string', enum: ['light', 'dark', 'no-preference'] },
  locale: { type: 'string' },
  user_agent: { type: 'string' },
  headers: { type: 'object', additionalProperties: { type: 'string' } },
  accept_language: { type: 'string' },
  encoding: { type: 'string' },
  block_resource_types: { type: 'array', items: { type: 'string' } },
  block_url_patterns: { type: 'array', items: { type: 'string' } },
  block_ads: { type: 'boolean' },
  record_har: { type: 'boolean' },
  http_auth: {
    type: 'object',
    properties: { username: { type: 'string' }, password: { type: 'string' } },
    required: ['username', 'password'],
    description: 'Requires verified domain',
  },
  client_certificates: {
    type: 'array',
    description: 'mTLS — requires verified domain',
    items: {
      type: 'object',
      required: ['origin', 'cert', 'key'],
      properties: {
        origin: { type: 'string' },
        cert: { type: 'string' },
        key: { type: 'string' },
        passphrase: { type: 'string' },
      },
    },
  },
} as const;

const scoutError = {
  type: 'object',
  required: ['error', 'code', 'retryable'],
  properties: {
    error: { type: 'string' },
    code: { type: 'string' },
    retryable: { type: 'boolean' },
    details: { type: 'object', additionalProperties: true },
    captcha_detected: { type: 'boolean' },
  },
};

const bearer = [{ ScoutApiKey: [] }, { ScoutApiKeyHeader: [] }];

function op(
  summary: string,
  opts: {
    tags: string[];
    body?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    security?: boolean;
    credits?: string;
  },
) {
  const description = opts.credits ? `${summary}\n\n**Credits:** ${opts.credits}` : summary;
  return {
    summary,
    description,
    tags: opts.tags,
    ...(opts.security === false ? {} : { security: bearer }),
    ...(opts.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: opts.body } },
          },
        }
      : {}),
    responses: opts.responses ?? {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
      },
      '400': { description: 'Validation / policy', content: { 'application/json': { schema: scoutError } } },
      '401': { description: 'Unauthorized', content: { 'application/json': { schema: scoutError } } },
      '402': { description: 'Credits exhausted', content: { 'application/json': { schema: scoutError } } },
      '403': { description: 'Forbidden / domain verify', content: { 'application/json': { schema: scoutError } } },
      '429': { description: 'Rate limited', content: { 'application/json': { schema: scoutError } } },
    },
  };
}

export function buildScoutOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Macro Scout API',
      version: '0.7.0',
      description: [
        'Web Verification / Site Inspection API — raw facts only, no content archive.',
        '',
        '**Auth:** `Authorization: Bearer <api-key>` or `X-Scout-Key: <api-key>`',
        '',
        'Create account-backed keys (`sk_scout_…`) in My Account → Scout.',
        'Docs: https://docs.macrocontent.dev/scout/',
      ].join('\n'),
    },
    servers: [
      { url: 'https://api.scout.macrocontent.dev', description: 'Production' },
    ],
    tags: [
      { name: 'Meta' },
      { name: 'DNS & robots' },
      { name: 'Crawl' },
      { name: 'Domains' },
      { name: 'Templates' },
      { name: 'Screenshot' },
      { name: 'Checks' },
      { name: 'Assert' },
      { name: 'Diff' },
      { name: 'Extract & inspect' },
      { name: 'Journey' },
      { name: 'Performance & sandbox' },
      { name: 'Jobs' },
    ],
    components: {
      securitySchemes: {
        ScoutApiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API key',
          description: 'Account key `sk_scout_…` or env-configured key',
        },
        ScoutApiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Scout-Key',
        },
      },
      schemas: {
        ScoutError: scoutError,
        BrowseOptions: { type: 'object', properties: browseProps },
      },
    },
    paths: {
      '/health': {
        get: op('Health check', {
          tags: ['Meta'],
          security: false,
          credits: '0',
          responses: {
            '200': {
              description: 'Service status including browser pool and stealth_runtime availability',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string' },
                      stealth_runtime: {
                        type: 'object',
                        properties: {
                          enabled: { type: 'boolean' },
                          available: { type: 'boolean' },
                          profile: { type: 'string', example: 'chromium-stealth-init-v2' },
                          notes: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      },
      '/': {
        get: op('API discovery', {
          tags: ['Meta'],
          security: false,
          credits: '0',
          responses: {
            '200': {
              description: 'Endpoint map',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        }),
      },
      '/v1/usage': {
        get: op('Per-key usage counters', { tags: ['Meta'], credits: '0' }),
      },
      '/v1/devices': {
        get: op('Device presets (iPhone, Pixel, …)', { tags: ['Meta'], credits: '0' }),
      },
      '/v1/dns': {
        post: op('DNS record lookup', {
          tags: ['DNS & robots'],
          credits: '1',
          body: {
            type: 'object',
            required: ['hostname'],
            properties: {
              hostname: { type: 'string', example: 'example.com' },
              types: {
                type: 'array',
                items: { type: 'string', enum: ['A', 'AAAA', 'TXT', 'CNAME', 'MX', 'NS', 'SOA'] },
              },
            },
          },
        }),
      },
      '/v1/robots': {
        post: op('robots.txt decision + sitemap URLs', {
          tags: ['DNS & robots'],
          credits: '1',
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              user_agent: { type: 'string' },
            },
          },
        }),
      },
      '/v1/crawl': {
        post: op('Multi-page link discovery (no content archive)', {
          tags: ['Crawl'],
          credits: '15 + 2×max_pages (up-front)',
          body: {
            type: 'object',
            required: ['start_url'],
            properties: {
              start_url: { type: 'string', format: 'uri' },
              max_depth: { type: 'integer', default: 2 },
              max_pages: { type: 'integer', default: 25, maximum: 100 },
              same_origin: { type: 'boolean', default: true },
              allow_hosts: { type: 'array', items: { type: 'string' } },
              seed_from_sitemap: { type: 'boolean' },
              respect_robots: { type: 'boolean' },
            },
          },
        }),
      },
      '/v1/domains': {
        get: op('List domains for this API key / account', { tags: ['Domains'], credits: '0' }),
        post: op('Register domain for ownership verify', {
          tags: ['Domains'],
          credits: '0',
          body: {
            type: 'object',
            required: ['hostname'],
            properties: { hostname: { type: 'string', example: 'example.com' } },
          },
        }),
      },
      '/v1/domains/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: op('Get domain', { tags: ['Domains'], credits: '0' }),
        delete: op('Delete domain', { tags: ['Domains'], credits: '0' }),
      },
      '/v1/domains/{id}/verify': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: op('Verify domain (DNS TXT or well-known file)', {
          tags: ['Domains'],
          credits: '0',
        }),
      },
      '/v1/templates': {
        get: op('List extract templates', { tags: ['Templates'], credits: '0' }),
        post: op('Create extract template', {
          tags: ['Templates'],
          credits: '0',
          body: {
            type: 'object',
            required: ['name', 'fields'],
            properties: {
              name: { type: 'string' },
              slug: { type: 'string' },
              hostname: { type: 'string' },
              fields: { type: 'array', items: { type: 'object' } },
            },
          },
        }),
      },
      '/v1/templates/{idOrSlug}': {
        parameters: [{ name: 'idOrSlug', in: 'path', required: true, schema: { type: 'string' } }],
        get: op('Get template', { tags: ['Templates'], credits: '0' }),
        patch: op('Update template', {
          tags: ['Templates'],
          credits: '0',
          body: { type: 'object', additionalProperties: true },
        }),
        delete: op('Delete template', { tags: ['Templates'], credits: '0' }),
      },
      '/v1/screenshot': {
        post: op('Capture screenshot (binary jpeg/png/pdf)', {
          tags: ['Screenshot'],
          credits: '8',
          body: {
            allOf: [
              {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  mode: { type: 'string', enum: ['viewport', 'fullpage'], default: 'fullpage' },
                  width: { type: 'integer', default: 1280 },
                  height: { type: 'integer', default: 800 },
                  format: { type: 'string', enum: ['jpeg', 'png', 'pdf'], default: 'jpeg' },
                  quality: { type: 'integer', minimum: 1, maximum: 100 },
                  wait_ms: { type: 'integer' },
                },
              },
              { $ref: '#/components/schemas/BrowseOptions' },
            ],
          },
          responses: {
            '200': {
              description: 'Image or PDF bytes',
              content: {
                'image/jpeg': { schema: { type: 'string', format: 'binary' } },
                'image/png': { schema: { type: 'string', format: 'binary' } },
                'application/pdf': { schema: { type: 'string', format: 'binary' } },
              },
            },
            '402': { description: 'Credits exhausted', content: { 'application/json': { schema: scoutError } } },
          },
        }),
      },
      '/v1/screenshot/json': {
        post: op('Screenshot as JSON (base64 + optional HAR)', {
          tags: ['Screenshot'],
          credits: '8',
          body: {
            allOf: [
              {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  mode: { type: 'string', enum: ['viewport', 'fullpage'] },
                  format: { type: 'string', enum: ['jpeg', 'png'] },
                },
              },
              { $ref: '#/components/schemas/BrowseOptions' },
            ],
          },
        }),
      },
      '/v1/screenshot/viewports': {
        post: op('Multi-viewport screenshots', {
          tags: ['Screenshot'],
          credits: '8 × viewport count',
          body: {
            type: 'object',
            required: ['url', 'viewports'],
            properties: {
              url: { type: 'string', format: 'uri' },
              viewports: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                    device: { type: 'string' },
                  },
                },
              },
            },
          },
        }),
      },
      '/v1/screenshot/diff': {
        post: op('Pixel diff vs client PNG reference', {
          tags: ['Screenshot'],
          credits: '10',
          body: {
            type: 'object',
            required: ['url', 'reference_png_base64'],
            properties: {
              url: { type: 'string', format: 'uri' },
              reference_png_base64: { type: 'string' },
              tolerance: { type: 'number' },
            },
          },
        }),
      },
      '/v1/checks/visibility': {
        post: op('Element visibility / occlusion check', {
          tags: ['Checks'],
          credits: '3',
          body: {
            type: 'object',
            required: ['url', 'selector'],
            properties: {
              url: { type: 'string', format: 'uri' },
              selector: { type: 'string' },
              scroll_into_view: { type: 'boolean' },
              expect: { type: 'object', additionalProperties: true },
            },
          },
        }),
      },
      '/v1/assert': {
        post: op(
          'Batch assertions — one page load, many pass/fail rules (`passed` + `results`)',
          {
            tags: ['Assert'],
            credits: '3 + 1 per assert after the first (max 25)',
            body: {
              type: 'object',
              required: ['url', 'assert'],
              properties: {
                url: { type: 'string', format: 'uri' },
                assert: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 25,
                  items: {
                    type: 'object',
                    required: ['selector'],
                    properties: {
                      selector: { type: 'string' },
                      exists: { type: 'boolean' },
                      visible: { type: 'boolean' },
                      not_covered: { type: 'boolean' },
                      count: { type: 'integer' },
                      count_min: { type: 'integer' },
                      count_max: { type: 'integer' },
                      contains: { type: 'string' },
                      text: { type: 'string' },
                      matches: { type: 'string', description: 'RegExp source' },
                      href_contains: { type: 'string' },
                      attr: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          value: { type: 'string' },
                        },
                      },
                      soft: {
                        type: 'boolean',
                        description: 'Report failure but do not flip overall passed',
                      },
                    },
                  },
                },
                scroll_into_view: { type: 'boolean' },
                ignore_selectors: { type: 'array', items: { type: 'string' } },
                ...browseProps,
              },
            },
          },
        ),
      },
      '/v1/checks/security': {
        post: op('TLS, headers, mixed content, CMP signals', {
          tags: ['Checks'],
          credits: '5',
          body: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string', format: 'uri' }, ...browseProps },
          },
        }),
      },
      '/v1/checks/a11y': {
        post: op('axe-core + contrast/tab/ARIA raw nodes', {
          tags: ['Checks'],
          credits: '5',
          body: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string', format: 'uri' }, ...browseProps },
          },
        }),
      },
      '/v1/checks/tech': {
        post: op('CMS / framework / analytics facts', {
          tags: ['Checks'],
          credits: '3',
          body: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string', format: 'uri' }, ...browseProps },
          },
        }),
      },
      '/v1/checks/cookies': {
        post: op('Cookie inventory after page load (not CMP)', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/checks/console': {
        post: op('Console messages during load (cap 200)', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/checks/network': {
        post: op('Network summary (status classes, CORS, slowest)', {
          tags: ['Checks'],
          credits: '4',
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              top_slowest: { type: 'boolean' },
              ...browseProps,
            },
          },
        }),
      },
      '/v1/checks/assets': {
        post: op('Failed stylesheet/image/font/script requests', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/checks/json-ld': {
        post: op('JSON-LD parse + schema field gaps', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/checks/canonical': {
        post: op('Redirect chain + canonical link', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/checks/sitemap': {
        post: op('Resolve sitemaps via robots.txt and /sitemap.xml', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } } },
        }),
      },
      '/v1/checks/images': {
        post: op('Image tag inventory (cap 200)', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/checks/resources': {
        post: op('Resource type counts + transfer estimates', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/checks/a11y-snapshot': {
        post: op('A11y inventory (buttons, headings, landmarks, aria)', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/checks/forms': {
        post: op('Form inventory (cap 50)', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/checks/opengraph': {
        post: op('Open Graph / Twitter meta (+ optional screenshot)', {
          tags: ['Checks'],
          credits: '3 (8 with screenshot: true)',
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              screenshot: { type: 'boolean' },
              ...browseProps,
            },
          },
        }),
      },
      '/v1/checks/links': {
        post: op('Shallow internal link graph (max 100)', {
          tags: ['Checks'],
          credits: '3',
          body: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, ...browseProps } },
        }),
      },
      '/v1/diff/dom': {
        post: op('DOM tree diff between two URLs', {
          tags: ['Diff'],
          credits: '8',
          body: {
            type: 'object',
            properties: {
              url_a: { type: 'string', format: 'uri' },
              url_b: { type: 'string', format: 'uri' },
              before_url: { type: 'string', format: 'uri' },
              after_url: { type: 'string', format: 'uri' },
              ...browseProps,
            },
          },
        }),
      },
      '/v1/diff/headers': {
        post: op('Compare response headers between two URLs', {
          tags: ['Diff'],
          credits: '4',
          body: {
            type: 'object',
            properties: {
              url_a: { type: 'string', format: 'uri' },
              url_b: { type: 'string', format: 'uri' },
              before_url: { type: 'string', format: 'uri' },
              after_url: { type: 'string', format: 'uri' },
            },
          },
        }),
      },
      '/v1/extract': {
        post: op('DOM field extract (or template_id)', {
          tags: ['Extract & inspect'],
          credits: '3',
          body: {
            allOf: [
              {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  template_id: { type: 'string' },
                  fields: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['name', 'selector', 'type'],
                      properties: {
                        name: { type: 'string' },
                        selector: { type: 'string' },
                        type: {
                          type: 'string',
                          enum: [
                            'exists',
                            'text',
                            'html',
                            'attribute',
                            'count',
                            'list',
                            'similar',
                            'selector',
                          ],
                        },
                        attribute: { type: 'string' },
                        adaptive: {
                          type: 'boolean',
                          description: 'Relocate by class/text when the selector misses',
                        },
                        match_text: {
                          type: 'string',
                          description: 'Hint text used with adaptive relocation',
                        },
                      },
                    },
                  },
                },
              },
              { $ref: '#/components/schemas/BrowseOptions' },
            ],
          },
        }),
      },
      '/v1/inspect': {
        post: op('Page inspect pack (meta, headings, links, …)', {
          tags: ['Extract & inspect'],
          credits: '3',
          body: {
            allOf: [
              {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  include: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'meta',
                        'headings',
                        'links',
                        'images',
                        'json_ld',
                        'headers',
                        'security',
                        'tech',
                        'files',
                        'a11y',
                      ],
                    },
                  },
                },
              },
              { $ref: '#/components/schemas/BrowseOptions' },
            ],
          },
        }),
      },
      '/v1/files': {
        post: op('Discover downloadable file links', {
          tags: ['Extract & inspect'],
          credits: '3',
          body: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string', format: 'uri' }, ...browseProps },
          },
        }),
      },
      '/v1/pdf/extract': {
        post: op('Extract text from a PDF URL (no OCR)', {
          tags: ['Extract & inspect'],
          credits: '4',
          body: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string', format: 'uri' } },
          },
        }),
      },
      '/v1/journey': {
        post: op('Multi-step browser journey', {
          tags: ['Journey'],
          credits: '10 + 2/step (+15 if evaluate; +1/step debug screenshots)',
          body: {
            type: 'object',
            required: ['steps'],
            properties: {
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['type'],
                  properties: {
                    type: {
                      type: 'string',
                      enum: [
                        'navigate',
                        'set_content',
                        'interact',
                        'extract',
                        'visibility',
                        'screenshot',
                        'evaluate',
                        'wait_for_function',
                      ],
                    },
                    url: { type: 'string' },
                    action: {
                      type: 'string',
                      enum: ['click', 'type', 'fill', 'scroll', 'hover', 'press', 'select', 'wait'],
                    },
                    selector: { type: 'string' },
                    text: { type: 'string' },
                    expression: { type: 'string', description: 'evaluate — Pro only' },
                  },
                },
              },
              cookies: { type: 'array', items: { type: 'object' } },
              dismiss_cookie_banner: {
                type: 'boolean',
                description:
                  'After each navigate/set_content, best-effort dismiss of known CMP banners (fixed allowlist). No domain verify required.',
              },
              solve_captcha: browseProps.solve_captcha,
              stealth: browseProps.stealth,
              capture_xhr: browseProps.capture_xhr,
              fetch_mode: browseProps.fetch_mode,
              debug: {
                description:
                  'Visual debug: attach page URL + viewport screenshot to each step (or only on error). Prefer on_error_only in production.',
                oneOf: [
                  { type: 'boolean' },
                  {
                    type: 'object',
                    properties: {
                      screenshots: { type: 'boolean', default: true },
                      on_error_only: { type: 'boolean', default: false },
                      format: { type: 'string', enum: ['jpeg', 'png'] },
                      quality: { type: 'integer', minimum: 1, maximum: 100 },
                    },
                  },
                ],
              },
              width: { type: 'integer' },
              height: { type: 'integer' },
              user_agent: { type: 'string' },
              headers: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
        }),
      },
      '/v1/performance': {
        post: op('Navigation timing / Web Vitals-style raw metrics', {
          tags: ['Performance & sandbox'],
          credits: '5',
          body: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string', format: 'uri' }, ...browseProps },
          },
        }),
      },
      '/v1/sandbox': {
        post: op('Load HTML/JS snippet in isolated page', {
          tags: ['Performance & sandbox'],
          credits: '5',
          body: {
            type: 'object',
            properties: {
              html: { type: 'string' },
              url: { type: 'string', format: 'uri' },
              scripts: { type: 'array', items: { type: 'string' } },
            },
          },
        }),
      },
      '/v1/jobs': {
        post: op('Enqueue batch job (+ optional signed webhook)', {
          tags: ['Jobs'],
          credits: 'sum of nested requests',
          body: {
            type: 'object',
            required: ['requests'],
            properties: {
              webhook_url: { type: 'string', format: 'uri' },
              webhook_secret: { type: 'string' },
              requests: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['type'],
                  properties: {
                    type: {
                      type: 'string',
                      enum: [
                        'screenshot',
                        'extract',
                        'visibility',
                        'inspect',
                        'performance',
                        'journey',
                        'crawl',
                      ],
                    },
                    body: { type: 'object', additionalProperties: true },
                    stop_if: {
                      type: 'object',
                      description:
                        'If the step result matches these fields, skip remaining steps. Job completes with stopped_early: true (not failed).',
                      properties: {
                        visible: { type: 'boolean' },
                        exists: { type: 'boolean' },
                        overall_pass: { type: 'boolean' },
                        status: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      },
      '/v1/jobs/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: op('Poll job until expires_at', {
          tags: ['Jobs'],
          credits: '0',
        }),
      },
    },
  };
}

export const scoutOpenApiSpec = buildScoutOpenApiSpec();
