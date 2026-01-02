import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { Module } from '../../module/Module';
import { BabelTransformer } from '../../transforms/babel';
import { CSSTransformer } from '../../transforms/css';
import { HTMLTransformer } from '../../transforms/html';
import { StyleTransformer } from '../../transforms/style';
import { Preset } from '../Preset';

export class VanillaPreset extends Preset {
  defaultHtmlBody = '';
  defaultEntryPoints: string[] = ['index.html', 'index.js', 'src/index.html', 'src/index.js'];

  constructor() {
    super('vanilla');
  }

  async init(bundler: Bundler): Promise<void> {
    await super.init(bundler);

    await Promise.all([
      this.registerTransformer(new BabelTransformer()),
      this.registerTransformer(new CSSTransformer()),
      this.registerTransformer(new StyleTransformer()),
      this.registerTransformer(new HTMLTransformer()),
    ]);
  }

  mapTransformers(module: Module): Array<[string, any]> {
    // JavaScript/TypeScript files
    if (/\.(m|c)?(t|j)sx?$/.test(module.filepath) && !module.filepath.endsWith('.d.ts')) {
      return [
        [
          'babel-transformer',
          {
            presets: [],
            plugins: ['@babel/plugin-proposal-explicit-resource-management'],
          },
        ],
      ];
    }

    // CSS files
    if (/\.css$/.test(module.filepath)) {
      return [
        ['css-transformer', {}],
        ['style-transformer', {}],
      ];
    }

    // HTML files
    if (/\.html?$/.test(module.filepath)) {
      return [['html-transformer', {}]];
    }

    throw new Error(`No transformer for ${module.filepath}`);
  }

  augmentDependencies(dependencies: DepMap): DepMap {
    dependencies['core-js'] = '3.22.7';
    return dependencies;
  }
}
