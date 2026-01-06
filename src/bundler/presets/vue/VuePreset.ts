import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { Module } from '../../module/Module';
import { BabelTransformer } from '../../transforms/babel';
import { CSSTransformer } from '../../transforms/css';
import { HTMLTransformer } from '../../transforms/html';
import { StyleTransformer } from '../../transforms/style';
import { VueTransformer } from '../../transforms/vue';
import { Preset } from '../Preset';

export class VuePreset extends Preset {
  defaultHtmlBody = '<div id="app"></div>';
  defaultEntryPoints: string[] = ['src/main.js', 'src/main.ts', 'main.js', 'main.ts', 'index.js', 'src/index.js'];

  constructor() {
    super('vue');
  }

  async init(bundler: Bundler): Promise<void> {
    await super.init(bundler);

    await Promise.all([
      this.registerTransformer(new BabelTransformer()),
      this.registerTransformer(new VueTransformer()),
      this.registerTransformer(new CSSTransformer()),
      this.registerTransformer(new StyleTransformer()),
      this.registerTransformer(new HTMLTransformer()),
    ]);
  }

  mapTransformers(module: Module): Array<[string, any]> {
    // Vue Single File Components
    if (/\.vue$/.test(module.filepath)) {
      return [
        ['vue-transformer', {}],
        [
          'babel-transformer',
          {
            presets: [],
            plugins: ['@babel/plugin-proposal-explicit-resource-management'],
          },
        ],
      ];
    }

    // JavaScript/TypeScript files (non-node_modules)
    if (/^(?!\/node_modules\/).*\.(m|c)?(t|j)sx?$/.test(module.filepath) && !module.filepath.endsWith('.d.ts')) {
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

    // JavaScript/TypeScript files (node_modules)
    if (/\.(m|c)?(t|j)sx?$/.test(module.filepath) && !module.filepath.endsWith('.d.ts')) {
      return [
        [
          'babel-transformer',
          {
            presets: [],
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
    if (!dependencies['vue']) {
      dependencies['vue'] = '^3.3.0';
    }
    dependencies['core-js'] = '3.22.7';
    return dependencies;
  }
}
