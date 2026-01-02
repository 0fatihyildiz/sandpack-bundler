import { ITranspilationContext, ITranspilationResult, Transformer } from '../Transformer';

export interface HTMLTransformerConfig {
  // Future config options
}

/**
 * HTML Transformer
 * - Extracts inline <script> tags and creates virtual modules
 * - Extracts inline <style> tags and injects them
 * - Handles external script/style references as dependencies
 */
export class HTMLTransformer extends Transformer<HTMLTransformerConfig> {
  constructor() {
    super('html-transformer');
  }

  async transform(ctx: ITranspilationContext, _config: HTMLTransformerConfig): Promise<ITranspilationResult> {
    const { code, module } = ctx;
    const dependencies = new Set<string>();

    let processedHTML = code;
    const inlineScripts: string[] = [];
    const inlineStyles: string[] = [];

    // Extract external script src dependencies
    const externalScriptRegex = /<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi;
    let match;
    while ((match = externalScriptRegex.exec(code)) !== null) {
      const src = match[1];
      if (!src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('//')) {
        // Resolve relative path
        const resolvedPath = src.startsWith('/') ? src : `/${src}`;
        dependencies.add(resolvedPath);
      }
    }

    // Extract external stylesheet dependencies
    const externalStyleRegex = /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']stylesheet["'][^>]*>/gi;
    const externalStyleRegex2 = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;

    for (const regex of [externalStyleRegex, externalStyleRegex2]) {
      while ((match = regex.exec(code)) !== null) {
        const href = match[1];
        if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('//')) {
          const resolvedPath = href.startsWith('/') ? href : `/${href}`;
          dependencies.add(resolvedPath);
        }
      }
    }

    // Extract inline scripts
    const inlineScriptRegex = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptIndex = 0;
    while ((match = inlineScriptRegex.exec(code)) !== null) {
      const scriptContent = match[1].trim();
      if (scriptContent) {
        inlineScripts.push(scriptContent);
        // Create virtual module path for inline script
        const virtualPath = `${module.filepath}__inline_script_${scriptIndex}.js`;
        scriptIndex++;
        // We'll handle inline scripts differently - they get evaluated directly
      }
    }

    // Extract inline styles
    const inlineStyleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    while ((match = inlineStyleRegex.exec(code)) !== null) {
      const styleContent = match[1].trim();
      if (styleContent) {
        inlineStyles.push(styleContent);
      }
    }

    // Generate compiled code that will:
    // 1. Inject inline styles
    // 2. Execute inline scripts
    const compiledCode = `
(function() {
  // Inline styles
  ${inlineStyles.map((style, i) => `
  (function() {
    var style = document.createElement('style');
    style.setAttribute('data-sandpack-inline', '${i}');
    style.textContent = ${JSON.stringify(style)};
    document.head.appendChild(style);
  })();
  `).join('\n')}

  // Inline scripts
  ${inlineScripts.map((script) => `
  (function() {
    ${script}
  })();
  `).join('\n')}
})();
`;

    return {
      code: compiledCode,
      dependencies,
    };
  }
}
