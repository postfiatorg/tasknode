import { builtInTaskNodeExtensions } from "./builtins.jsx";
import { createTaskNodeExtensionRegistry } from "./registry.js";

export { defineTaskNodeExtension } from "./registry.js";
export { ExtensionSurface } from "./ExtensionSurface.jsx";
export const appExtensionRegistry = createTaskNodeExtensionRegistry(builtInTaskNodeExtensions);
