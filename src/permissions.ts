import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

/** The host rejects the permission promise when the user declines. */
export async function requestPermissions(ctx: Pick<SpindleFrontendContext, 'permissions'>, permissions: string[], reason: string): Promise<string[]> {
  try { return await ctx.permissions.request(permissions, { reason }); }
  catch { return []; }
}
