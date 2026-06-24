const EXTENSIONLESS_FILE = /^(\.{1,2}\/|\/|file:)/;

export async function resolve(specifier, context, defaultResolve) {
  try {
    return await defaultResolve(specifier, context, defaultResolve);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !EXTENSIONLESS_FILE.test(specifier) || /\.[a-z0-9]+$/i.test(specifier)) {
      throw error;
    }
    for (const extension of [".js", ".jsx", ".mjs"]) {
      try {
        return await defaultResolve(`${specifier}${extension}`, context, defaultResolve);
      } catch (fallbackError) {
        if (fallbackError?.code !== "ERR_MODULE_NOT_FOUND") throw fallbackError;
      }
    }
    throw error;
  }
}
