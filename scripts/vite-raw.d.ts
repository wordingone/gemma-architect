// Stub declaration so root tsc (which lacks vite/client) can resolve ?raw imports
// that originate in web/src and are transitively pulled in by scripts/*.
declare module "*.yaml?raw" {
  const content: string;
  export default content;
}
declare module "*.json?raw" {
  const content: string;
  export default content;
}
