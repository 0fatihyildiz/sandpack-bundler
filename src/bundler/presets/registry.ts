import * as logger from '../../utils/logger';
import { AngularPreset } from './angular/AngularPreset';
import { Preset } from './Preset';
import { ReactPreset } from './react/ReactPreset';
import { SolidPreset } from './solid/SolidPreset';
import { SveltePreset } from './svelte/SveltePreset';
import { VanillaPreset } from './vanilla/VanillaPreset';
import { VuePreset } from './vue/VuePreset';

const PRESET_MAP: Map<string, Preset> = new Map([
  // React variants
  ['react', new ReactPreset()],
  ['react-ts', new ReactPreset()],

  // Solid
  ['solid', new SolidPreset()],

  // Vue
  ['vue', new VuePreset()],
  ['vue-ts', new VuePreset()],
  ['vue3', new VuePreset()],
  ['vue3-ts', new VuePreset()],

  // Svelte
  ['svelte', new SveltePreset()],
  ['svelte-ts', new SveltePreset()],

  // Angular
  ['angular', new AngularPreset()],
  ['angular-ts', new AngularPreset()],

  // Vanilla / static / HTML
  ['vanilla', new VanillaPreset()],
  ['vanilla-ts', new VanillaPreset()],
  ['static', new VanillaPreset()],
  ['html', new VanillaPreset()],

  // Parcel
  ['parcel', new VanillaPreset()],

  // Node
  ['node', new VanillaPreset()],
  ['node-ts', new VanillaPreset()],

  // Vite variants
  ['vite', new VanillaPreset()],
  ['vite-react', new ReactPreset()],
  ['vite-react-ts', new ReactPreset()],
  ['vite-vue', new VuePreset()],
  ['vite-vue-ts', new VuePreset()],
  ['vite-svelte', new SveltePreset()],
  ['vite-svelte-ts', new SveltePreset()],

  // Next.js
  ['nextjs', new ReactPreset()],
  ['next', new ReactPreset()],

  // Astro
  ['astro', new VanillaPreset()],

  // Test runners
  ['test-ts', new VanillaPreset()],
]);

export function getPreset(presetName: string): Preset {
  const foundPreset = PRESET_MAP.get(presetName);
  if (!foundPreset) {
    logger.warn(`Unknown preset ${presetName}, falling back to Vanilla`);
    return new VanillaPreset();
  }
  return foundPreset;
}
