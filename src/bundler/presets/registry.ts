import * as logger from '../../utils/logger';
import { Preset } from './Preset';
import { ReactPreset } from './react/ReactPreset';
import { SolidPreset } from './solid/SolidPreset';
import { VanillaPreset } from './vanilla/VanillaPreset';

const PRESET_MAP: Map<string, Preset> = new Map([
  ['react', new ReactPreset()],
  ['solid', new SolidPreset()],
  ['vanilla', new VanillaPreset()],
  ['static', new VanillaPreset()],
  ['html', new VanillaPreset()],
]);

export function getPreset(presetName: string): Preset {
  const foundPreset = PRESET_MAP.get(presetName);
  if (!foundPreset) {
    logger.warn(`Unknown preset ${presetName}, falling back to React`);
    return new ReactPreset();
  }
  return foundPreset;
}
