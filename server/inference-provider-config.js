import { providerApiKey, providerBaseUrl } from "./inference-policy.js";
export const ambientApiKey = (env = process.env) => providerApiKey("ambient", env);
export const ambientBaseUrl = (env = process.env) => providerBaseUrl("ambient", env);
export const vercelAiGatewayApiKey = (env = process.env) => providerApiKey("vercel", env);
export const vercelAiGatewayBaseUrl = (env = process.env) => providerBaseUrl("vercel", env);
export const vercelAiGatewayConfigured = (env = process.env) => Boolean(vercelAiGatewayApiKey(env));
