// Ambient module declarations to satisfy TypeScript when importing ESM .js paths from .ts sources
// This avoids "Cannot find module './path/to/module.js' or its corresponding type declarations" editor errors.

declare module "./routes/*.js" {
  const value: any;
  export default value;
}

declare module "./services/*.js" {
  const value: any;
  export default value;
}

declare module "./middlewares/*.js" {
  const value: any;
  export default value;
}

declare module "./utils/*.js" {
  const value: any;
  export default value;
}

declare module "./validators/*.js" {
  const value: any;
  export default value;
}

declare module "./types/*.js" {
  const value: any;
  export default value;
}
