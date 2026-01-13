import * as logger from '../../utils/logger';
import evaluate from './eval';
import { HotContext } from './hot';
import { Module } from './Module';

// Node.js built-in modules for runtime resolution fallback
const NODE_BUILTIN_MODULES = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https',
  'module', 'net', 'os', 'path', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty',
  'url', 'util', 'vm', 'zlib', 'process', '_stream_duplex', '_stream_passthrough',
  '_stream_readable', '_stream_transform', '_stream_writable'
]);

function getBuiltinShimPath(specifier: string): string | null {
  let moduleName = specifier;
  if (moduleName.startsWith('node:')) {
    moduleName = moduleName.slice(5);
  }
  const baseName = moduleName.split('/')[0];
  if (NODE_BUILTIN_MODULES.has(baseName)) {
    return `/node_modules/${baseName}/index.js`;
  }
  return null;
}

class EvaluationContext {
  exports: any;
  globals: any;
  hot: HotContext;
  id: string;

  constructor(evaluation: Evaluation) {
    this.exports = {};
    this.globals = {};
    this.hot = evaluation.module.hot;
    this.id = evaluation.module.id;
  }
}

export class Evaluation {
  module: Module;
  context: EvaluationContext;

  constructor(module: Module) {
    this.module = module;

    const code = module.compiled + `\n//# sourceURL=${location.origin}${this.module.filepath}`;

    this.context = new EvaluationContext(this);
    this.context.exports = evaluate(code, this.require.bind(this), this.context, {}, {});
  }

  require(specifier: string): any {
    let moduleFilePath = this.module.dependencyMap.get(specifier);

    // If not found in dependency map, check if it's a Node.js built-in module
    if (!moduleFilePath) {
      const shimPath = getBuiltinShimPath(specifier);
      if (shimPath) {
        moduleFilePath = shimPath;
      }
    }

    if (!moduleFilePath) {
      logger.debug('Require', {
        dependencies: this.module.dependencyMap,
        specifier,
      });

      throw new Error(`Dependency "${specifier}" not collected from "${this.module.filepath}"`);
    }

    const module = this.module.bundler.getModule(moduleFilePath);
    if (!module) {
      // For Node.js built-ins, create a module on-the-fly from the shim
      const shimPath = getBuiltinShimPath(specifier);
      if (shimPath) {
        try {
          const shimCode = this.module.bundler.fs.readFileSync(shimPath);
          const shimModule = new Module(shimPath, shimCode, true, this.module.bundler);
          this.module.bundler.modules.set(shimPath, shimModule);
          return shimModule.evaluate().context.exports ?? {};
        } catch (err) {
          // Shim not found, return empty object for Node.js built-ins
          return {};
        }
      }
      throw new Error(`Module "${moduleFilePath}" has not been transpiled`);
    }
    return module.evaluate().context.exports ?? {};
  }
}
