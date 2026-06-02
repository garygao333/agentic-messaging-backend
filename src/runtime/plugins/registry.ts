import { dentalBookingPlugin } from './dentistBooking.js';
import type { RuntimePlugin, RuntimePluginContext } from './types.js';

export const runtimePlugins: RuntimePlugin[] = [dentalBookingPlugin];

export async function runRuntimePlugins(context: RuntimePluginContext): Promise<boolean> {
  for (const plugin of runtimePlugins) {
    if (!plugin.matches(context.agent)) continue;
    try {
      if (await plugin.handleTurn(context)) return true;
    } catch (err) {
      console.warn(`[runtime-plugin:${plugin.id}] failed:`, err);
    }
  }
  return false;
}
