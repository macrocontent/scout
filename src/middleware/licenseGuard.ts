import type { NextFunction, Request, Response } from 'express';
import { scoutConfig } from '../config';
import { ScoutError, sendScoutError } from '../lib/errors';
import { getLicenseState } from '../lib/licenseClient';

/**
 * Blocks /v1 when self_hosted deployment has no valid license.
 */
export function scoutLicenseGuard() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (scoutConfig.deploymentMode !== 'self_hosted') {
      next();
      return;
    }

    const license = getLicenseState();
    if (!license.valid) {
      sendScoutError(
        res,
        new ScoutError(
          'LICENSE_INVALID',
          license.lastError || 'Valid SCOUT_LICENSE_KEY required for self-hosted Scout',
          { status: 403 },
        ),
      );
      return;
    }

    next();
  };
}
