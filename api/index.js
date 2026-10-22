import { createVercelHandler } from '../server/vercel-handler.js';

// Keep one handler across invocations so public metadata caches, provider
// pacing and admission limits can be reused within this warm instance.
export default createVercelHandler();
