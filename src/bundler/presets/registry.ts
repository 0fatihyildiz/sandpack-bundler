import * as logger from '../../utils/logger';
import { AngularPreset } from './angular/AngularPreset';
import { Preset } from './Preset';
import { ReactPreset } from './react/ReactPreset';
import { SolidPreset } from './solid/SolidPreset';
import { SveltePreset } from './svelte/SveltePreset';
import { VanillaPreset } from './vanilla/VanillaPreset';
import { VitePreset } from './vite/VitePreset';
import { VuePreset } from './vue/VuePreset';
import { WebpackPreset } from './webpack/WebpackPreset';

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
  ['vite', new VitePreset()],
  ['vite-react', new VitePreset()],
  ['vite-react-ts', new VitePreset()],
  ['vite-vue', new VuePreset()],
  ['vite-vue-ts', new VuePreset()],
  ['vite-svelte', new SveltePreset()],
  ['vite-svelte-ts', new SveltePreset()],
  ['vite-ts', new VitePreset()],

  // Webpack variants
  ['webpack', new WebpackPreset()],
  ['webpack-react', new WebpackPreset()],
  ['webpack-ts', new WebpackPreset()],

  // Next.js
  ['nextjs', new ReactPreset()],
  ['next', new ReactPreset()],

  // Astro
  ['astro', new VanillaPreset()],

  // Test runners
  ['test-ts', new VanillaPreset()],

  // Create React App (uses webpack internally)
  ['create-react-app', new WebpackPreset()],
  ['cra', new WebpackPreset()],
]);

export function getPreset(presetName: string): Preset {
  const foundPreset = PRESET_MAP.get(presetName);
  if (!foundPreset) {
    logger.warn(`Unknown preset ${presetName}, falling back to Vanilla`);
    return new VanillaPreset();
  }
  return foundPreset;
}
