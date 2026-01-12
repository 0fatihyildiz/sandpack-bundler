import { Bundler } from '../../bundler';
import { DepMap } from '../../module-registry';
import { Module } from '../../module/Module';
import { BabelTransformer } from '../../transforms/babel';
import { CSSTransformer } from '../../transforms/css';
import { HTMLTransformer } from '../../transforms/html';
import { ReactRefreshTransformer } from '../../transforms/react-refresh';
import { StyleTransformer } from '../../transforms/style';
import { Preset } from '../Preset';

export class VitePreset extends Preset {
  defaultHtmlBody = '<div id="root"></div>';
  defaultEntryPoints: string[] = [
    'index.html',
    'src/main.tsx',
    'src/main.ts',
    'src/main.jsx',
    'src/main.js',
    'main.tsx',
    'main.ts',
    'main.jsx',
    'main.js',
  ];

  constructor() {
    super('vite');
  }

  async init(bundler: Bundler): Promise<void> {
    await super.init(bundler);

    await Promise.all([
      this.registerTransformer(new BabelTransformer()),
      this.registerTransformer(new ReactRefreshTransformer()),
      this.registerTransformer(new CSSTransformer()),
      this.registerTransformer(new StyleTransformer()),
      this.registerTransformer(new HTMLTransformer()),
    ]);

    // Enable HMR for Vite
    bundler.enableHMR();
  }

  mapTransformers(module: Module): Array<[string, any]> {
    // JSX/TSX files (non-node_modules) - with React Refresh for HMR
    if (/^(?!\/node_modules\/).*\.(jsx|tsx)$/.test(module.filepath)) {
      return [
        [
          'babel-transformer',
          {
            presets: [
              ['react', { runtime: 'automatic' }],
              'typescript',
            ],
            plugins: [
              ['react-refresh/babel', { skipEnvCheck: true }],
              '@babel/plugin-proposal-explicit-resource-management',
            ],
          },
        ],
        ['react-refresh-transformer', {}],
      ];
    }

    // TypeScript files (non-node_modules)
    if (/^(?!\/node_modules\/).*\.tsx?$/.test(module.filepath) && !module.filepath.endsWith('.d.ts')) {
      return [
        [
          'babel-transformer',
          {
            presets: ['typescript'],
            plugins: ['@babel/plugin-proposal-explicit-resource-management'],
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
            presets: [['react', { runtime: 'automatic' }]],
            plugins: ['@babel/plugin-proposal-explicit-resource-management'],
          },
        ],
      ];
    }

    // Node modules JS/TS
    if (/\.(m|c)?(t|j)sx?$/.test(module.filepath) && !module.filepath.endsWith('.d.ts')) {
      return [
        [
          'babel-transformer',
          {
            presets: [['react', { runtime: 'automatic' }]],
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
    // Add react-refresh for HMR
    if (!dependencies['react-refresh']) {
      dependencies['react-refresh'] = '^0.11.0';
    }
    dependencies['core-js'] = '3.22.7';
    return dependencies;
  }
}
