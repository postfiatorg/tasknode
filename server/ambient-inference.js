// Legacy import compatibility. Application calls use the shared Vercel-first router.
// Ambient transport is selected only by that router's backup policy.
export {
  INFERENCE_MODELS as AMBIENT_MODELS,
  inferenceConfigured as ambientConfigured,
  resolveInferenceModel as resolveAmbientModel,
  inferenceChatCompletion as ambientChatCompletion,
  inferenceChatCompletionStream as ambientChatCompletionStream,
  inferenceChatCompletionResponse as ambientChatCompletionResponse,
  inferenceFetchCompatibility as ambientFetchCompatibility,
  inferenceModels as ambientModels,
  normalizeInferenceRequest as normalizeAmbientChatRequest,
  outputTextFromInference as outputTextFromAmbient,
} from "./inference.js";
export { ambientApiKey, ambientBaseUrl } from "./inference-provider-config.js";
