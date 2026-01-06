import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { Module } from '../../module/Module';
import { BabelTransformer } from '../../transforms/babel';
import { AngularTransformer } from '../../transforms/angular';
import { CSSTransformer } from '../../transforms/css';
import { HTMLTransformer } from '../../transforms/html';
import { StyleTransformer } from '../../transforms/style';
import { Preset } from '../Preset';

export class AngularPreset extends Preset {
  defaultHtmlBody = '<app-root></app-root>';
  defaultEntryPoints: string[] = ['src/main.ts', 'main.ts', 'src/index.ts', 'index.ts'];

  constructor() {
    super('angular');
  }

  async init(bundler: Bundler): Promise<void> {
    await super.init(bundler);

    await Promise.all([
      this.registerTransformer(new BabelTransformer()),
      this.registerTransformer(new AngularTransformer()),
      this.registerTransformer(new CSSTransformer()),
      this.registerTransformer(new StyleTransformer()),
      this.registerTransformer(new HTMLTransformer()),
    ]);
  }

  mapTransformers(module: Module): Array<[string, any]> {
    // TypeScript files with Angular decorators
    if (/\.component\.ts$/.test(module.filepath) || /\.service\.ts$/.test(module.filepath) || /\.module\.ts$/.test(module.filepath)) {
      return [
        ['angular-transformer', {}],
        [
          'babel-transformer',
          {
            presets: ['typescript'],
            plugins: [
              ['@babel/plugin-proposal-decorators', { legacy: true }],
              ['@babel/plugin-proposal-class-properties', { loose: true }],
              '@babel/plugin-proposal-explicit-resource-management',
            ],
          },
        ],
      ];
    }

    // TypeScript files (non-node_modules)
    if (/^(?!\/node_modules\/).*\.tsx?$/.test(module.filepath) && !module.filepath.endsWith('.d.ts')) {
      return [
        [
          'babel-transformer',
          {
            presets: ['typescript'],
            plugins: [
              ['@babel/plugin-proposal-decorators', { legacy: true }],
              ['@babel/plugin-proposal-class-properties', { loose: true }],
              '@babel/plugin-proposal-explicit-resource-management',
            ],
          },
        ],
      ];
    }

    // JavaScript files (non-node_modules)
    if (/^(?!\/node_modules\/).*\.(m|c)?jsx?$/.test(module.filepath)) {
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
    // Angular core dependencies
    if (!dependencies['@angular/core']) {
      dependencies['@angular/core'] = '^17.0.0';
    }
    if (!dependencies['@angular/common']) {
      dependencies['@angular/common'] = '^17.0.0';
    }
    if (!dependencies['@angular/platform-browser']) {
      dependencies['@angular/platform-browser'] = '^17.0.0';
    }
    if (!dependencies['@angular/platform-browser-dynamic']) {
      dependencies['@angular/platform-browser-dynamic'] = '^17.0.0';
    }
    if (!dependencies['rxjs']) {
      dependencies['rxjs'] = '^7.8.0';
    }
    if (!dependencies['zone.js']) {
      dependencies['zone.js'] = '^0.14.0';
    }
    dependencies['core-js'] = '3.22.7';
    return dependencies;
  }
}
