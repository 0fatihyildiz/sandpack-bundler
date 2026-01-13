declare module 'micromatch' {
  interface Options {
    capture?: boolean;
    [key: string]: any;
  }

  function micromatch(list: string[], patterns: string | string[], options?: Options): string[];

  namespace micromatch {
    function makeRe(pattern: string, options?: Options): RegExp;
    function isMatch(string: string, pattern: string | string[], options?: Options): boolean;
    function match(list: string[], patterns: string | string[], options?: Options): string[];
  }

  export = micromatch;
}
