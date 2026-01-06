import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

export interface SvelteTransformerConfig {
  // Future config options
}

/**
 * Svelte Component Transformer
 * Parses .svelte files and compiles them to JavaScript
 */
export class SvelteTransformer extends Transformer<SvelteTransformerConfig> {
  constructor() {
    super('svelte-transformer');
  }

  async transform(ctx: ITranspilationContext, _config: SvelteTransformerConfig): Promise<ITranspilationResult> {
    const { code, module } = ctx;
    const dependencies = new Set<string>();

    // Parse Svelte component sections
    const scriptMatch = code.match(/<script(?:\s+lang="(ts|typescript)")?(?:\s+context="module")?>([\s\S]*?)<\/script>/g);
    const styleMatch = code.match(/<style(?:\s+lang="(scss|less|css)")?>([\s\S]*?)<\/style>/);

    // Extract template (everything not in script or style tags)
    let template = code
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .trim();

    // Parse scripts
    let moduleScript = '';
    let instanceScript = '';

    if (scriptMatch) {
      scriptMatch.forEach((script) => {
        const isModule = script.includes('context="module"');
        const content = script.match(/<script[^>]*>([\s\S]*?)<\/script>/);
        if (content) {
          if (isModule) {
            moduleScript = content[1].trim();
          } else {
            instanceScript = content[1].trim();
          }
        }
      });
    }

    // Extract styles
    const styles = styleMatch ? styleMatch[2].trim() : '';

    // Extract imports from scripts
    const extractImports = (scriptContent: string) => {
      const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*\s*from\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(scriptContent)) !== null) {
        dependencies.add(match[1]);
      }
    };

    extractImports(moduleScript);
    extractImports(instanceScript);

    // Generate a simplified compiled output
    // Note: Full Svelte compilation requires svelte/compiler
    const compiledCode = `
// Module-level script
${moduleScript}

// Inject styles
${styles ? `
(function() {
  var style = document.createElement('style');
  style.setAttribute('data-svelte-component', '${module.filepath}');
  style.textContent = ${JSON.stringify(styles)};
  document.head.appendChild(style);
})();
` : ''}

// Svelte component (simplified runtime)
function create_fragment(ctx) {
  return {
    c() {
      // Create elements
    },
    m(target, anchor) {
      // Mount
    },
    p(ctx, dirty) {
      // Update
    },
    d(detaching) {
      // Destroy
    }
  };
}

function instance($$self, $$props, $$invalidate) {
  ${instanceScript}
  return [];
}

class Component {
  constructor(options) {
    this.$$fragment = create_fragment(this.$$.ctx);
    if (options.target) {
      this.$$fragment.m(options.target, options.anchor);
    }
  }

  $destroy() {
    this.$$fragment.d(true);
  }
}

// Template (for reference)
const __svelte_template__ = ${JSON.stringify(template)};

export default Component;
`;

    return {
      code: compiledCode,
      dependencies,
    };
  }
}
