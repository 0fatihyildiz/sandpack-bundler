import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

export interface VueTransformerConfig {
  // Future config options
}

/**
 * Vue Single File Component (SFC) Transformer
 * Parses .vue files and extracts template, script, and style sections
 */
export class VueTransformer extends Transformer<VueTransformerConfig> {
  constructor() {
    super('vue-transformer');
  }

  async transform(ctx: ITranspilationContext, _config: VueTransformerConfig): Promise<ITranspilationResult> {
    const { code, module } = ctx;
    const dependencies = new Set<string>();

    // Parse Vue SFC sections
    const templateMatch = code.match(/<template>([\s\S]*?)<\/template>/);
    const scriptMatch = code.match(/<script(?:\s+setup)?(?:\s+lang="(ts|typescript)")?>([\s\S]*?)<\/script>/);
    const styleMatch = code.match(/<style(?:\s+scoped)?(?:\s+lang="(scss|less|css)")?>([\s\S]*?)<\/style>/g);

    const template = templateMatch ? templateMatch[1].trim() : '';
    const scriptContent = scriptMatch ? scriptMatch[2].trim() : '';
    const isSetup = code.includes('<script setup');
    const isTypeScript = scriptMatch && (scriptMatch[1] === 'ts' || scriptMatch[1] === 'typescript');

    // Extract styles
    const styles: string[] = [];
    if (styleMatch) {
      styleMatch.forEach((style) => {
        const styleContent = style.match(/<style[^>]*>([\s\S]*?)<\/style>/);
        if (styleContent) {
          styles.push(styleContent[1].trim());
        }
      });
    }

    // Extract imports from script
    const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*\s*from\s*['"]([^'"]+)['"]/g;
    let importMatch;
    while ((importMatch = importRegex.exec(scriptContent)) !== null) {
      const importPath = importMatch[1];
      if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
        // External dependency
        dependencies.add(importPath);
      } else {
        dependencies.add(importPath);
      }
    }

    // Always need Vue
    dependencies.add('vue');

    // Generate compiled code
    let compiledCode: string;

    if (isSetup) {
      // Vue 3 <script setup> syntax
      compiledCode = `
import { defineComponent, h } from 'vue';
${scriptContent.replace(/import\s*{[^}]*}\s*from\s*['"]vue['"];?/g, '')}

// Inject styles
${styles.map((style, i) => `
(function() {
  var style = document.createElement('style');
  style.setAttribute('data-vue-component', '${module.filepath}-${i}');
  style.textContent = ${JSON.stringify(style)};
  document.head.appendChild(style);
})();
`).join('')}

// Template render function (simplified - full compilation requires @vue/compiler-sfc)
const template = ${JSON.stringify(template)};

export default {
  template: template,
  setup() {
    return {};
  }
};
`;
    } else {
      // Options API or Composition API
      compiledCode = `
${scriptContent}

// Inject styles
${styles.map((style, i) => `
(function() {
  var style = document.createElement('style');
  style.setAttribute('data-vue-component', '${module.filepath}-${i}');
  style.textContent = ${JSON.stringify(style)};
  document.head.appendChild(style);
})();
`).join('')}

// Add template to default export
if (typeof exports.default === 'object') {
  exports.default.template = ${JSON.stringify(template)};
}
`;
    }

    return {
      code: compiledCode,
      dependencies,
    };
  }
}
