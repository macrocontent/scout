import { z } from 'zod';

/** Optional early-exit rule on a job step (evaluated against that step's result). */
export const StopIfSchema = z
  .object({
    visible: z.boolean().optional(),
    exists: z.boolean().optional(),
    overall_pass: z.boolean().optional(),
    status: z.string().optional(),
  })
  .refine(
    (v) =>
      v.visible !== undefined ||
      v.exists !== undefined ||
      v.overall_pass !== undefined ||
      v.status !== undefined,
    { message: 'stop_if needs at least one field' },
  );

export type StopIf = z.infer<typeof StopIfSchema>;

/**
 * True when every specified stop_if field matches the step result.
 * Used after visibility (and similar) steps to skip the rest of the job.
 */
export function matchesStopIf(stopIf: StopIf | undefined | null, result: unknown): boolean {
  if (!stopIf) return false;
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;

  if (stopIf.visible !== undefined && r.visible !== stopIf.visible) return false;
  if (stopIf.exists !== undefined && r.exists !== stopIf.exists) return false;
  if (stopIf.overall_pass !== undefined && r.overall_pass !== stopIf.overall_pass) return false;
  if (stopIf.status !== undefined && r.status !== stopIf.status) return false;

  return true;
}

export function stopReason(stopIf: StopIf, stepIndex: number): string {
  const parts: string[] = [];
  if (stopIf.visible !== undefined) parts.push(`visible=${String(stopIf.visible)}`);
  if (stopIf.exists !== undefined) parts.push(`exists=${String(stopIf.exists)}`);
  if (stopIf.overall_pass !== undefined) parts.push(`overall_pass=${String(stopIf.overall_pass)}`);
  if (stopIf.status !== undefined) parts.push(`status=${stopIf.status}`);
  return `stop_if matched at step ${stepIndex}: ${parts.join(', ')}`;
}
