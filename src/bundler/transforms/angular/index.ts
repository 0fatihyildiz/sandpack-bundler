import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

export interface AngularTransformerConfig {
  // Future config options
}

/**
 * Angular Component Transformer
 * Handles Angular decorators and TypeScript
 */
export class AngularTransformer extends Transformer<AngularTransformerConfig> {
  constructor() {
    super('angular-transformer');
  }

  async transform(ctx: ITranspilationContext, _config: AngularTransformerConfig): Promise<ITranspilationResult> {
    const { code } = ctx;
    const dependencies = new Set<string>();

    // Extract imports
    const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*\s*from\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(code)) !== null) {
      dependencies.add(match[1]);
    }

    // Angular always needs these
    dependencies.add('@angular/core');

    // Transform decorators to a simpler form
    // Note: Full Angular compilation requires @angular/compiler
    let transformedCode = code;

    // Transform @Component decorator
    transformedCode = transformedCode.replace(
      /@Component\s*\(\s*\{([^}]*)\}\s*\)/g,
      (match, content) => {
        return `/* @Component */ Object.defineProperty($1, '__annotations__', { value: [{${content}}] });`.replace('$1', 'arguments[0]');
      }
    );

    // Transform @Injectable decorator
    transformedCode = transformedCode.replace(
      /@Injectable\s*\(\s*\{([^}]*)\}\s*\)/g,
      '/* @Injectable */'
    );

    // Transform @NgModule decorator
    transformedCode = transformedCode.replace(
      /@NgModule\s*\(\s*\{([^}]*)\}\s*\)/g,
      '/* @NgModule */'
    );

    // Transform @Input, @Output decorators
    transformedCode = transformedCode.replace(/@Input\(\)/g, '/* @Input */');
    transformedCode = transformedCode.replace(/@Output\(\)/g, '/* @Output */');

    return {
      code: transformedCode,
      dependencies,
    };
  }
}
