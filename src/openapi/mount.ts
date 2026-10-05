import type { Express, NextFunction, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { scoutOpenApiSpec } from './spec';

const DOCS_FRAME_ANCESTORS = [
  "'self'",
  'https://docs.macrocontent.dev',
  'http://localhost:3008',
  'http://127.0.0.1:3008',
];

export function mountScoutSwagger(app: Express): void {
  app.get('/openapi.json', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(scoutOpenApiSpec);
  });

  app.use(
    '/docs',
    (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader(
        'Content-Security-Policy',
        `frame-ancestors ${DOCS_FRAME_ANCESTORS.join(' ')};`,
      );
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(scoutOpenApiSpec, {
      customSiteTitle: 'Macro Scout API',
      customCss: `
        .swagger-ui .topbar { background: #1a1a1a; border-bottom: 1px solid #333; }
        .swagger-ui .topbar .topbar-wrapper .link { display: none; }
      `,
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
      },
    }),
  );
}
